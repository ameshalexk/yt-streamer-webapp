// Loopback-only development fixture; never authenticates or contacts production.
// The pet hostname gate is transformed only in this server's response, not source.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
let selected='fixture-tab-a';
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')){
   let result={ok:true,playlists:[],items:[],sessions:[],data:[]};
   if(url.pathname==='/api/teslamon/devices')result={enabled:true,selectedDeviceKey:selected,modelConfigured:false,localTranscription:false,devices:[{deviceKey:'fixture-tab-a',label:'Fixture player A'},{deviceKey:'fixture-tab-b',label:'Fixture decoy B'}]};
   if(url.pathname==='/api/teslamon/select'){
    let text='';for await(const b of req){text+=b;if(text.length>2048)throw Error('body limit');}
    const body=JSON.parse(text);selected=body.deviceKey;result={status:'selected',deviceKey:selected};
   }
   if(url.pathname==='/api/teslamon/command')result={status:'observed',playbackPhase:'paused',fullscreenMode:'none'};
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));return;
  }
  const name=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
  const full=path.resolve(root,'.'+name);
  if(!full.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  let bytes=await fs.readFile(full);
  if(name==='/teslamon-pet.js')bytes=Buffer.from(String(bytes).replace(/if\(\[.*?\]\.includes\(location\.hostname\)&&location\.protocol==='https:'\)/,"if(location.hostname==='127.0.0.1')"));
  res.writeHead(200,{'content-type':types[path.extname(full)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/'}));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>process.exit(0)));
