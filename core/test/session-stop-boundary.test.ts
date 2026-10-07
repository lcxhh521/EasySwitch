import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEasySwitchServer} from '../src/server.ts';
import {Store} from '../src/store.ts';
test('legacy numeric interactive process IDs cannot authorize a kill or program discovery',async t=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-unowned-stop-'));let signals=0;t.mock.method(process,'kill',()=>{signals++;return true;});
 const server=createEasySwitchServer({port:0,store:new Store(dir),secrets:{get:async()=>{assert.fail('no keys');},set:async()=>{},delete:async()=>{}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/sessions/12345/stop`,{method:'POST',headers:{'x-easyswitch':'1'},body:'{}'});assert.equal(r.status,409);const value=await r.json() as any;assert.ok(value.uiError);assert.equal(signals,0);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
