import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let next = 0;
const threads = new Map(),
  calls = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line),
    p = request.params || {};
  if (!request.method) {
    const call = calls.get(request.id);
    if (!call) return;
    send({
      method: 'item/completed',
      params: {
        threadId: call.thread,
        item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(request.result) },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: call.thread, turn: { id: 'turn', status: 'completed' } },
    });
    return;
  }
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') return send({ id: request.id, result: {} });
  if (request.method === 'thread/start') {
    const id = 'thread_' + ++next;
    threads.set(id, p);
    return send({ id: request.id, result: { thread: { id } } });
  }
  if (request.method === 'thread/resume') {
    if ('dynamicTools' in p) return send({ id: request.id, error: { code: -32602 } });
    threads.set(p.threadId, { ...p, dynamicTools: threads.get(p.threadId)?.dynamicTools || [] });
    return send({ id: request.id, result: { thread: { id: p.threadId } } });
  }
  if (request.method === 'turn/interrupt') return send({ id: request.id, result: {} });
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    const prompt = p.input[0].text;
    if (prompt === 'inspect-tools') {
      send({
        method: 'item/completed',
        params: {
          threadId: p.threadId,
          item: {
            type: 'agentMessage',
            phase: 'final_answer',
            text: JSON.stringify({
              settings: threads.get(p.threadId),
              args: process.argv.slice(2),
            }),
          },
        },
      });
      return send({
        method: 'turn/completed',
        params: { threadId: p.threadId, turn: { id: 'turn', status: 'completed' } },
      });
    }
    if (prompt.startsWith('image-')) {
      const formats = {
        png: '89504e470d0a1a0a',
        jpeg: 'ffd8ff',
        webp: '524946460400000057454250',
        gif: '474946383961',
      };
      const format = prompt.slice(6);
      const item = {
        type: 'imageGeneration',
        id: 'image-1',
        status: format === 'failed' ? 'failed' : 'completed',
        result:
          format === 'invalid'
            ? 'not an image'
            : Buffer.from(formats[format] || formats.png, 'hex').toString('base64'),
        savedPath: '/must/not/read/private-file.png',
      };
      send({
        method: 'item/started',
        params: { threadId: p.threadId, item: { ...item, status: 'in_progress', result: '' } },
      });
      for (let i = 0; i < 2; i++)
        send({ method: 'item/completed', params: { threadId: p.threadId, item } });
      send({
        method: 'item/completed',
        params: {
          threadId: p.threadId,
          item: { type: 'agentMessage', phase: 'final_answer', text: '' },
        },
      });
      return send({
        method: 'turn/completed',
        params: {
          threadId: p.threadId,
          turn: { status: format === 'interrupted' ? 'interrupted' : 'completed' },
        },
      });
    }
    if (prompt === 'slow') return;
    if (prompt === 'fail')
      return send({
        method: 'turn/completed',
        params: { threadId: p.threadId, turn: { status: 'failed' } },
      });
    send({
      method: 'item/completed',
      params: {
        threadId: p.threadId,
        item: { type: 'agentMessage', phase: 'commentary', text: 'progress only' },
      },
    });
    if (threads.get(p.threadId)?.dynamicTools?.length) {
      const id = 'server_' + ++next;
      calls.set(id, { thread: p.threadId });
      return send({
        id,
        method: 'item/tool/call',
        params: {
          threadId: p.threadId,
          turnId: 'turn',
          callId: id,
          tool: 'echo',
          arguments: { value: prompt },
        },
      });
    }
    send({
      method: 'item/completed',
      params: {
        threadId: p.threadId,
        item: { type: 'agentMessage', phase: 'final_answer', text: 'final result' },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: p.threadId, turn: { status: 'completed' } },
    });
  }
});
