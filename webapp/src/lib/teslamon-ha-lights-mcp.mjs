// TeslaMon ONLY: a three-tool, isolated, light-domain MCP facade over the
// existing private Home Assistant MCP. Never forward arbitrary tool names or
// generic services, locks, covers, garage, scripts, scenes or automations.
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const upstreamRoot=path.join(os.homedir(),'Documents/Codex/2026-09-22/home-assistant-ai-agnostic');
const resolve=createRequire(path.join(upstreamRoot,'package.json'));
const load=async spec=>import(pathToFileURL(resolve.resolve(spec)).href);
const [{McpServer},{StdioServerTransport},{Client},{StreamableHTTPClientTransport},{z}]=await Promise.all([
  load('@modelcontextprotocol/sdk/server/mcp.js'),
  load('@modelcontextprotocol/sdk/server/stdio.js'),
  load('@modelcontextprotocol/sdk/client/index.js'),
  load('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  load('zod')
]);
const upstream=new Client({name:'teslamon-light-restricted-client',version:'1.0.0'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3848/mcp'));
let connected=false;
const ensure=async()=>{if(!connected){await upstream.connect(transport);connected=true}};
const server=new McpServer({name:'teslamon-lights-only',version:'1.0.0'});
const onlyLight=value=>typeof value==='string' && /^light\.[a-z0-9_]{1,100}$/.test(value);
const room=value=>typeof value==='string' && /^[a-zA-Z0-9_() '\-]{2,70}$/.test(value);
const fail=code=>({content:[{type:'text',text:JSON.stringify({success:false,code})}],isError:true});
const call=async(name,args)=>{
  try{
    await ensure();
    const answer=await upstream.callTool({name,arguments:args});
    const result=answer.structuredContent??{};
    // Never pass raw HA credentials or excessive entity metadata to Codex.
    const selected=JSON.stringify(result);
    if(selected.length>6000)return fail('result_too_large');
    return {content:[{type:'text',text:selected}],isError:answer.isError===true||result.success===false};
  }catch{return fail('home_assistant_unavailable')}
};
server.registerTool('search_lights',{
  description:'Find Home Assistant LIGHT entity IDs by a room/name. Read only. No switches, locks, garage or other devices.',
  inputSchema:{query:z.string().min(2).max(70)},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
},async({query})=>call('search_entities',{query,domain:'light',limit:8}));
server.registerTool('get_light_state',{
  description:'Read on/off/brightness state of exactly one Home Assistant light ID returned by search_lights.',
  inputSchema:{entity_id:z.string().max(110)},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
},async({entity_id})=>onlyLight(entity_id)?
  call('get_entity_state',{entity_id}):fail('light_entity_required'));
server.registerTool('set_light',{
  description:'Turn on/off an explicit Home Assistant light or a named room lighting group. ONLY for an explicit user-requested light change. Brightness percent, RGB color, or color temperature are optional only for turn_on. No other device domains.' ,
  inputSchema:{
    action:z.enum(['turn_on','turn_off']),
    entity_id:z.string().max(110).optional(),
    area:z.string().max(70).optional(),
    brightness_pct:z.number().int().min(1).max(100).optional(),
    rgb_color:z.tuple([z.number().int().min(0).max(255),z.number().int().min(0).max(255),z.number().int().min(0).max(255)]).optional(),
    color_temp_kelvin:z.number().int().min(1000).max(10000).optional()
  },
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
},async({action,entity_id,area,brightness_pct,rgb_color,color_temp_kelvin})=>{
  if(Boolean(entity_id)===Boolean(area)||entity_id&&!onlyLight(entity_id)||
     area&&!room(area)||
     (action==='turn_off'&&(brightness_pct!==undefined||rgb_color||color_temp_kelvin))||
     (rgb_color&&color_temp_kelvin))
    return fail('invalid_light_target');
  return call('control_light',{
    action,...(entity_id?{entity_id}:{area}),
    ...(brightness_pct!==undefined?{brightness_pct}:{}),
    ...(rgb_color?{rgb_color}:{}),
    ...(color_temp_kelvin?{color_temp_kelvin}:{})
  });
});
await server.connect(new StdioServerTransport());
