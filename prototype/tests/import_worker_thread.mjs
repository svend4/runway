// import_worker_thread.mjs — поток Node для модели блокировки и сквозной проверки (import_worker_model.test.mjs).
// Это не тест: тот же handle_message и split_reply, что в demo/import_worker.mjs, но в потоке worker_threads (в браузере — Web Worker; у обоих отдельный поток
// и копирование сообщений). Файл лежит в tests/ рядом с остальными помощниками и запускается только тестом.

import { parentPort } from 'node:worker_threads';
import { handle_message, split_reply } from '../demo/import_worker.mjs';

parentPort.on('message', (m) => { for (const r of split_reply(handle_message(m))) parentPort.postMessage(r); });
parentPort.postMessage({ v: 1, ready: true });
