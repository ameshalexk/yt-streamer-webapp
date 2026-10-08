// Experimental authenticated LOOPBACK MCP endpoint for S2-01.
// Implements 2025-11-25 stateless Streamable HTTP JSON responses.
// No public deployment, OAuth, Cloudflare Access or Voice capability implied.
const VERSION = "2025-11-25";
const id = {type:"string",minLength:36,maxLength:36,description:"Explicit paired device_id from list_devices"};
const query = {type:"string",minLength:2,maxLength:120};
const media = {type:"string",minLength:1,maxLength:160};
const numeric = (min,max) => ({type:"number",minimum:min,maximum:max});
const tool = (name,description,properties={},required=[],readOnly=false) => ({
  name,description,inputSchema:{type:"object",properties,required,additionalProperties:false},
  annotations:{readOnlyHint:readOnly},
});
export const devMcpTools = [
  tool("list_devices","List authorized active paired browser tabs. Choose the exact device_id; labels aren't trusted identities.",{},[],true),
  tool("get_player_state","Read the selected browser's observed player state.",{device_id:id},["device_id"],true),
  tool("search_media","Search the selected tab's supported YouTube provider. Results are untrusted external metadata.",{device_id:id,query,limit:{type:"integer",minimum:1,maximum:10}},["device_id","query"],true),
  tool("play_media","Start a media_id returned by search_media on this same selected tab; start is not guaranteed.",{device_id:id,media_id:media},["device_id","media_id"]),
  tool("pause","Pause playback on the selected browser.",{device_id:id},["device_id"]),
  tool("resume","Resume playback on the selected browser when allowed; may need touch.",{device_id:id},["device_id"]),
  tool("next","Advance the existing playback queue if present.",{device_id:id},["device_id"]),
  tool("seek","Seek the selected playback if seekable.",{device_id:id,position_seconds:numeric(0,86400)},["device_id","position_seconds"]),
  tool("set_volume","Adjust tab volume only where verified. Explicitly unsupported otherwise.",{device_id:id,value_percent:numeric(0,100)},["device_id","value_percent"]),
  tool("request_fullscreen","Request fullscreen; native fullscreen requires browser user activation.",{device_id:id},["device_id"]),
];
const valid = new Map(devMcpTools.map(x=>[x.name,x]));
const fail = (code,message) => ({jsonrpc:"2.0",id:null,error:{code,message}});
const result = (id,value) => ({jsonrpc:"2.0",id,result:value});
function status(res,code,data) {
  res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(JSON.stringify(data));
}
function keysValid(schema,args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (Object.keys(args).some(k=>!(k in schema.properties))) return false;
  if (schema.required.some(k=>!(k in args))) return false;
  for(const [k,v] of Object.entries(args)) {
    const spec=schema.properties[k];
    if (typeof v !== (spec.type==="integer" ? "number" : spec.type) || (spec.type==="integer" && !Number.isInteger(v))) return false;
    if (typeof v==="string" && ((spec.minLength && v.length<spec.minLength) || (spec.maxLength && v.length>spec.maxLength))) return false;
    if (typeof v==="number" && (!Number.isFinite(v) || v<spec.minimum || v>spec.maximum)) return false;
  }
  return true;
}
export async function handleDevMcp(req,res,registry,readJson) {
  if (req.method === "GET" || req.method === "DELETE") { status(res,405,fail(-32601,"method_not_supported"));return; }
  if (req.method !== "POST") {status(res,405,fail(-32601,"method_not_supported"));return;}
  if (!String(req.headers.accept||"").includes("application/json")
      || !String(req.headers.accept||"").includes("text/event-stream")) {status(res,406,fail(-32600,"accept_header_required"));return;}
  if (!String(req.headers["content-type"]||"").startsWith("application/json")) {status(res,415,fail(-32600,"json_content_type_required"));return;}
  if (req.headers["mcp-protocol-version"] && req.headers["mcp-protocol-version"] !== VERSION) {
    status(res,400,fail(-32600,"unsupported_protocol_version"));return;
  }
  let call;
  try {call=await readJson(req);}catch{status(res,400,fail(-32700,"invalid_json"));return;}
  if (!call || call.jsonrpc!=="2.0" || typeof call.method!=="string") {status(res,400,fail(-32600,"invalid_request"));return;}
  if (call.method==="notifications/initialized" && call.id===undefined) {res.writeHead(202,{"cache-control":"no-store"});res.end();return;}
  if (!(typeof call.id==="string" && call.id.length<=64) && !(Number.isSafeInteger(call.id))) {
    status(res,400,fail(-32600,"invalid_id"));return;
  }
  try {
    if (call.method==="initialize") {
      if (!["2025-11-25","2025-03-26"].includes(call.params?.protocolVersion)) {
        status(res,400,fail(-32602,"unsupported_client_version"));return;
      }
      status(res,200,result(call.id,{protocolVersion:VERSION,capabilities:{tools:{}},
        serverInfo:{name:"yt-streamer-dev-loopback",version:"0.1.0"}}));return;
    }
    if (call.method==="ping") {status(res,200,result(call.id,{}));return;}
    if (call.method==="tools/list") {status(res,200,result(call.id,{tools:devMcpTools}));return;}
    if (call.method==="tools/call") {
      const name=call.params?.name;
      const args=call.params?.arguments||{};
      const spec=valid.get(name);
      if (!spec) {status(res,200,result(call.id,{isError:true,content:[{type:"text",text:"unknown_tool"}]}));return;}
      if (!keysValid(spec.inputSchema,args)) {
        status(res,200,result(call.id,{isError:true,content:[{type:"text",text:"invalid_tool_arguments"}]}));return;
      }
      const output=name==="list_devices" ? {devices:registry.list("owner")}
        : await registry.dispatch({principal:"owner",deviceId:args.device_id,action:name,
          args:Object.fromEntries(Object.entries(args).filter(([k])=>k!=="device_id"))});
      status(res,200,result(call.id,{isError:["offline","failed","timeout_uncertain","rate_limited"].includes(output.status),
        content:[{type:"text",text:JSON.stringify(output)}],
        structuredContent:output}));return;
    }
    status(res,200,{jsonrpc:"2.0",id:call.id,error:{code:-32601,message:"method_not_found"}});
  } catch (error) {
    status(res,200,result(call.id,{isError:true,content:[{type:"text",text:String(error?.code||"tool_failed").slice(0,120)}]}));
  }
}
