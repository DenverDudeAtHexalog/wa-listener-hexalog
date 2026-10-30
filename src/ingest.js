import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadMediaMessage, extractMessageContent, getContentType, isJidGroup } from 'baileys';
import { q } from './db.js';
import { config } from './config.js';
import { bus } from './bus.js';

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video', // round video notes
};

const EXT_BY_MIME = {
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/msword': 'doc', 'text/plain': 'txt', 'text/csv': 'csv',
};

let download = downloadMediaMessage;
/** Test hook: swap the media downloader. */
export const _setDownloader = (fn) => { download = fn; };

const phoneOf = (jid) => (jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null);
const toNum = (v) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v || 0));

function stripNull(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

/** Turn a raw Baileys message into our row shape (no media download yet). */
export function parseMessage(msg) {
  const key = msg.key || {};
  const chatJid = key.remoteJid;
  if (!chatJid || !msg.message) return null;

  const inner = extractMessageContent(msg.message) || msg.message;
  const contentType = getContentType(inner);
  if (!contentType) return null;
  const c = inner[contentType];

  // Skip pure protocol/system stuff here; edits/deletes/reactions are handled separately.
  if (['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(contentType)) return null;

  const ctx = c?.contextInfo || null;
  const base = {
    id: key.id,
    chat_jid: chatJid,
    sender_jid: key.participantAlt || key.participant || (key.fromMe ? 'me' : chatJid),
    sender_name: msg.pushName || null,
    from_me: !!key.fromMe,
    ts: new Date(toNum(msg.messageTimestamp) * 1000 || Date.now()),
    quoted_id: ctx?.stanzaId || null,
    mentions: ctx?.mentionedJid?.length ? ctx.mentionedJid : null,
    type: 'other',
    text: null,
    media: null,
    is_voice_note: false,
  };
  base.sender_phone = phoneOf(base.sender_jid);

  switch (contentType) {
    case 'conversation':
      base.type = 'text'; base.text = inner.conversation; break;
    case 'extendedTextMessage':
      base.type = 'text'; base.text = c.text; break;
    case 'reactionMessage':
      return { reaction: { chat_jid: chatJid, message_id: c.key?.id, reactor_jid: base.sender_jid, emoji: c.text || '', ts: base.ts } };
    case 'locationMessage':
    case 'liveLocationMessage':
      base.type = 'location';
      base.text = [c.name, c.address, `${c.degreesLatitude},${c.degreesLongitude}`].filter(Boolean).join(' | ');
      break;
    case 'contactMessage':
      base.type = 'contact'; base.text = c.displayName || null; break;
    case 'contactsArrayMessage':
      base.type = 'contact'; base.text = (c.contacts || []).map((x) => x.displayName).join(', '); break;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      base.type = 'poll'; base.text = `${c.name}: ${(c.options || []).map((o) => o.optionName).join(' / ')}`; break;
    default:
      if (MEDIA_TYPES[contentType]) {
        base.type = MEDIA_TYPES[contentType];
        base.text = c.caption || null;
        base.is_voice_note = contentType === 'audioMessage' && !!c.ptt;
        base.media = {
          mime: c.mimetype || null,
          filename: c.fileName || null,
          seconds: c.seconds || null,
          size: c.fileLength ? toNum(c.fileLength) : null,
        };
      } else {
        base.type = contentType.replace(/Message$/, '');
      }
  }
  return base;
}

async function saveMedia(sock, msg, row) {
  const limit = config.maxMediaMb * 1024 * 1024;
  if (row.media.size && row.media.size > limit) {
    return { error: `skipped: ${row.media.size} bytes exceeds MAX_MEDIA_MB` };
  }
  try {
    const buf = await download(msg, 'buffer', {}, {
      logger: sock?.logger,
      reuploadRequest: sock?.updateMediaMessage,
    });
    if (buf.length > limit) return { error: 'skipped: too large' };
    const mime = (row.media.mime || '').split(';')[0].trim();
    const ext = (row.media.filename && path.extname(row.media.filename).slice(1)) || EXT_BY_MIME[mime] || 'bin';
    const day = row.ts.toISOString().slice(0, 10);
    const dir = path.join(config.dataDir, 'media', day);
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(dir, name), buf);
    return { path: path.join('media', day, name), size: buf.length };
  } catch (e) {
    return { error: e.message?.slice(0, 200) || 'download failed' };
  }
}

export function publicRow(r) {
  const base = config.publicBaseUrl;
  return {
    uid: Number(r.uid),
    id: r.id,
    chat_jid: r.chat_jid,
    group_name: r.group_name ?? undefined,
    sender_jid: r.sender_jid,
    sender_phone: r.sender_phone,
    sender_name: r.sender_name,
    from_me: r.from_me,
    timestamp: r.ts,
    type: r.type,
    text: r.text,
    quoted_id: r.quoted_id,
    mentions: r.mentions,
    is_voice_note: r.is_voice_note,
    deleted: r.deleted,
    edited_at: r.edited_at,
    transcript: r.transcript,
    media: r.media_path || r.media_error
      ? {
          url: r.media_path ? `${base}/api/media/${r.uid}` : null,
          mime: r.media_mime,
          size: r.media_size == null ? null : Number(r.media_size),
          filename: r.media_filename,
          seconds: r.media_seconds,
          error: r.media_error,
        }
      : null,
  };
}

const withGroupName = `SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid = m.chat_jid`;

export async function fetchMessageByUid(uid) {
  const { rows } = await q(`${withGroupName} WHERE m.uid = $1`, [uid]);
  return rows[0] ? publicRow(rows[0]) : null;
}

/**
 * Process a message from Baileys. `fromHistory` messages are stored but do not fire webhooks
 * and skip media download (WhatsApp usually has expired the media by then).
 */
export async function ingestMessage(sock, msg, { fromHistory = false } = {}) {
  const chat = msg.key?.remoteJid;
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return;
  if (!isJidGroup(chat) && !config.includeDirectChats) return;

  // Protocol messages: revoke (delete) and edit
  const inner = msg.message ? extractMessageContent(msg.message) || msg.message : null;
  const proto = inner?.protocolMessage;
  if (proto) {
    const targetId = proto.key?.id;
    if (proto.type === 0 && targetId) { // REVOKE
      const { rows } = await q(
        `UPDATE messages SET deleted = true WHERE chat_jid=$1 AND id=$2 RETURNING uid`, [chat, targetId]);
      if (rows[0] && !fromHistory) bus.emit('message.deleted', { chat_jid: chat, id: targetId, uid: Number(rows[0].uid) });
    } else if (proto.type === 14 && targetId) { // MESSAGE_EDIT
      const e = proto.editedMessage;
      const newText = e?.conversation || e?.extendedTextMessage?.text || null;
      const { rows } = await q(
        `UPDATE messages SET text = COALESCE($3, text), edited_at = now() WHERE chat_jid=$1 AND id=$2 RETURNING uid`,
        [chat, targetId, newText]);
      if (rows[0] && !fromHistory) bus.emit('message.updated', await fetchMessageByUid(rows[0].uid));
    }
    return;
  }

  const parsed = parseMessage(msg);
  if (!parsed) return;

  if (parsed.reaction) {
    const r = parsed.reaction;
    if (!r.message_id) return;
    if (!r.emoji) {
      await q('DELETE FROM reactions WHERE chat_jid=$1 AND message_id=$2 AND reactor_jid=$3', [r.chat_jid, r.message_id, r.reactor_jid]);
    } else {
      await q(
        `INSERT INTO reactions (chat_jid, message_id, reactor_jid, emoji, ts) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (chat_jid, message_id, reactor_jid) DO UPDATE SET emoji = EXCLUDED.emoji, ts = EXCLUDED.ts`,
        [r.chat_jid, r.message_id, r.reactor_jid, r.emoji, r.ts]);
    }
    if (!fromHistory) bus.emit('reaction', { ...r, timestamp: r.ts });
    return;
  }

  if (!parsed.id) return;

  let media = { path: null, size: parsed.media?.size ?? null, error: null };
  if (parsed.media && !fromHistory) {
    const saved = await saveMedia(sock, msg, parsed);
    media = { path: saved.path || null, size: saved.size ?? parsed.media.size, error: saved.error || null };
  }

  const { rows } = await q(
    `INSERT INTO messages
       (id, chat_jid, sender_jid, sender_phone, sender_name, from_me, ts, type, text, quoted_id, mentions,
        media_path, media_mime, media_size, media_filename, media_seconds, media_error, is_voice_note, from_history)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (chat_jid, id) DO NOTHING
     RETURNING uid`,
    [parsed.id, parsed.chat_jid, parsed.sender_jid, parsed.sender_phone, parsed.sender_name, parsed.from_me,
     parsed.ts, parsed.type, parsed.text, parsed.quoted_id, parsed.mentions ? JSON.stringify(stripNull(parsed.mentions)) : null,
     media.path, parsed.media?.mime ?? null, media.size, parsed.media?.filename ?? null, parsed.media?.seconds ?? null,
     media.error, parsed.is_voice_note, fromHistory]
  );
  if (!rows[0]) return; // duplicate
  if (!fromHistory) bus.emit('message.created', await fetchMessageByUid(rows[0].uid));
}

export async function upsertGroup(meta) {
  if (!meta?.id) return;
  const participants = (meta.participants || []).map((p) => ({
    jid: p.phoneNumber || p.id,
    lid: p.lid || (p.id?.endsWith('@lid') ? p.id : null),
    admin: p.admin || null,
  }));
  await q(
    `INSERT INTO wa_groups (jid, subject, description, owner_jid, created_at_wa, participants, participant_count, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (jid) DO UPDATE SET subject = COALESCE(EXCLUDED.subject, wa_groups.subject),
       description = COALESCE(EXCLUDED.description, wa_groups.description),
       owner_jid = COALESCE(EXCLUDED.owner_jid, wa_groups.owner_jid),
       participants = CASE WHEN jsonb_array_length(EXCLUDED.participants) > 0 THEN EXCLUDED.participants ELSE wa_groups.participants END,
       participant_count = CASE WHEN EXCLUDED.participant_count > 0 THEN EXCLUDED.participant_count ELSE wa_groups.participant_count END,
       updated_at = now()`,
    [meta.id, meta.subject || null, meta.desc || null, meta.ownerPn || meta.owner || null,
     meta.creation ? new Date(meta.creation * 1000) : null, JSON.stringify(participants), participants.length]
  );
}
