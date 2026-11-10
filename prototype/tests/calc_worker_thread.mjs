// calc_worker_thread.mjs — поток Node для модели блокировки расчёта экранов (calc_async_model.test.mjs).
// Это не тест: тот же handle_message, что в demo/calc_worker.mjs, но в потоке worker_threads (в браузере — Web Worker; у обоих отдельный поток и копирование сообщений).
// Файл лежит в tests/ рядом с остальными помощниками и запускается только тестом.

import { parentPort } from 'node:worker_threads';
import { handle_message } from '../demo/calc_worker.mjs';

parentPort.on('message', (m) => parentPort.postMessage(handle_message(m)));
parentPort.postMessage({ v: 1, ready: true });
