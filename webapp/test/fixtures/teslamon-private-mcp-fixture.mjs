// Inert test-only executable: synthetic relay; no network, real browser or Mac.
import {createTeslaMonMcpHandler,serveTeslaMonMcpStdio} from '../../src/lib/teslamon-private-mcp.js';
const authority=Object.freeze({
  origin:'https://stream.ameshalex.com',subject:'fixture-user',
  controllerId:'fixture-controller',
  deviceKey:'11111111-1111-4111-8111-111111111111',
  connectionId:'22222222-2222-4222-8222-222222222222',
  explicitSelection:true,tabConsent:true,authExpiresAt:Date.now()+600000
});
const handler=createTeslaMonMcpHandler({
  getAuthority:()=>authority,
  dispatch:async command=>({
    status:'observed',commandId:command.commandId,
    subject:command.binding.subject,deviceKey:command.binding.deviceKey,
    connectionId:command.binding.connectionId,observedAt:Date.now(),
    playbackPhase:'paused',fullscreenMode:'none'
  })
});
await serveTeslaMonMcpStdio(handler);
