// Entry point of a worker process (started by manager.js with NUMBER_ID set).
import { runWorker } from './worker-core.js';

runWorker();
