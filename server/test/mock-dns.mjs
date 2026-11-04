// A stand-in DNS server for tests (UDP, TXT records only), so the server's domain check runs a real DNS
// lookup: point PAGES_DNS_SERVERS (or txtResolver) at `server`.
//
//   records.set('_ylb-domain.shop.example.com', ['ylb-…'])   → those TXT values
//   records.set(name, [])                                    → the name exists, with no TXT record (ENODATA)
//   records.set(name, 'SERVFAIL')                            → the server fails (ESERVFAIL)
//   records.set(name, 'NO_ANSWER')                           → no reply at all (the lookup times out)
//   any other name                                           → doesn't exist (ENOTFOUND)

import dgram from 'node:dgram';

const TXT = 16;

/** A TXT answer for the question at offset 12 (a pointer to its name), one or more 255-byte strings. */
function txtRecord(value) {
  const text = Buffer.from(String(value), 'utf8');
  const parts = [];
  for (let i = 0; i === 0 || i < text.length; i += 255) {
    const chunk = text.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  const data = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0); // the name: the question's
  head.writeUInt16BE(TXT, 2);
  head.writeUInt16BE(1, 4); // IN
  head.writeUInt32BE(60, 6); // TTL
  head.writeUInt16BE(data.length, 10);
  return Buffer.concat([head, data]);
}

function answer(query, records, asked) {
  if (query.length < 17 || query.readUInt16BE(4) !== 1) return null;
  const labels = [];
  let o = 12;
  for (;;) {
    if (o >= query.length) return null;
    const len = query[o];
    if (len === 0) break;
    if (len & 0xc0) return null;
    labels.push(query.subarray(o + 1, o + 1 + len).toString('latin1'));
    o += 1 + len;
  }
  o += 1;
  if (o + 4 > query.length) return null;
  const type = query.readUInt16BE(o);
  const question = query.subarray(12, o + 4);
  const name = labels.join('.').toLowerCase();
  asked.push({ name, type });
  const entry = records.get(name);
  if (entry === 'NO_ANSWER') return null;
  let rcode = 0;
  let answers = [];
  if (entry === 'SERVFAIL') rcode = 2;
  else if (entry === undefined) rcode = 3; // NXDOMAIN
  else if (type === TXT) answers = entry.map(txtRecord);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(query.readUInt16BE(0), 0); // the query's id
  // a response, authoritative, recursion desired (as asked) and available, and the result code
  head.writeUInt16BE(0x8000 | 0x0400 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(answers.length, 6);
  return Buffer.concat([head, question, ...answers]);
}

export async function createMockDns() {
  const records = new Map();
  const asked = [];
  const socket = dgram.createSocket('udp4');
  socket.on('message', (query, from) => {
    try {
      const reply = answer(query, records, asked);
      if (reply) socket.send(reply, from.port, from.address);
    } catch {
      /* a query this stand-in can't read: no answer */
    }
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    records,
    /** every question asked: { name, type } */
    asked,
    /** for PAGES_DNS_SERVERS / txtResolver */
    server: `127.0.0.1:${socket.address().port}`,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}
