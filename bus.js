'use strict';

/**
 * Межпроцессная шина событий для нескольких узлов на одной машине.
 *
 * Узлы обмениваются событиями чата через loopback-мультикаст, поэтому
 * WebSocket-клиенты, подключённые к разным процессам, получают обновления
 * в реальном времени. Шина ограничена одной машиной: для нескольких хостов
 * нужен внешний брокер (Redis/NATS).
 */

const dgram = require('node:dgram');
const crypto = require('node:crypto');

const PORT = Number(process.env.BUS_PORT || 12100);
const GROUP = process.env.BUS_GROUP || '239.255.77.77';
const NODE_ID = crypto.randomBytes(6).toString('hex');

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const pending = [];
let handler = null;
let bound = false;

socket.on('message', (buf) => {
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    return;
  }
  if (!data || data.src === NODE_ID || !data.event) return;
  if (handler) handler(data.event);
  else pending.push(data.event);
});

socket.on('error', (err) => {
  console.error('[bus] udp error:', err.message);
});

socket.bind(PORT, () => {
  try {
    socket.addMembership(GROUP);
    socket.setMulticastLoopback(true);
  } catch (err) {
    console.error('[bus] multicast join failed:', err.message);
  }
  socket.unref();
  bound = true;
});

function publish(event) {
  if (!bound) return;
  const packet = Buffer.from(JSON.stringify({ src: NODE_ID, event }));
  socket.send(packet, PORT, GROUP, (err) => {
    if (err) console.error('[bus] send failed:', err.message);
  });
}

function onEvent(cb) {
  handler = cb;
  while (pending.length) cb(pending.shift());
}

module.exports = { publish, onEvent, NODE_ID };