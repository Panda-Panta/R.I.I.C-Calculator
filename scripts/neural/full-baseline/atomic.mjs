import { openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
/** Publish complete durable JSON atomically without replacing any existing final artifact. */
export function publishExclusiveJson(path,value) {
  const temporary=`${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd=openSync(temporary,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd); }
  catch(error){closeSync(fd);unlinkSync(temporary);throw error;}
  closeSync(fd);
  try { linkSync(temporary,path); } finally { unlinkSync(temporary); }
}
