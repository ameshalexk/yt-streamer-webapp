import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const adapter=await fs.readFile(new URL('../public/ai-media-agent-adapter.js',import.meta.url),'utf8');

function snapshot({mode='mjpeg',active=true,audio,video}={}){
  const classes=new Set(['playing',
    ...(mode==='webcodecs'?['cyberdash-mode']:[]),
    ...(mode==='buffered_mjpeg'?['mjpeg-buffered-mode']:[]),
    ...(mode==='mjpeg'?['mjpeg-mode']:[]),
    ...(mode==='native_video'?['video-mode']:[])
  ]);
  const screen={classList:{contains:name=>classes.has(name)}};
  const badge={classList:{contains:name=>name==='live'}};
  const nowPlaying={textContent:'Fixture title'};
  const elements={'#screen':screen,'#video':video,'#audio':audio,
    '#streamBadge':badge,'#nowPlaying':nowPlaying,'#mjpeg':null};
  const context={
    URLSearchParams,location:{hostname:'stream.ameshalex.com',search:''},
    document:{querySelector:selector=>elements[selector]||null},
    performance:{now:()=>1000},
    replayFn:active?()=>{}:null,playbackPaused:false,
    state:{youtubeSearchPlayingId:'AAAaa00000_'},streamAttempt:1,
    activeCompat:null,cyberdashPlayer:{currentTime:()=>0,isActive:()=>false},
    getStreamCurrentTime:()=>12,streamSeek:{duration:90},
    globalThis:null
  };
  context.globalThis=context;
  vm.runInNewContext(adapter,context,{filename:'ai-media-agent-adapter.js'});
  return context.YTStreamerMediaAgent.get_player_state();
}

test('adapter classifies audio element evidence without claiming speaker output',()=>{
  const cases=[
    [{active:false,mode:'mjpeg'},'idle'],
    [{mode:'mjpeg',audio:null},'element_missing'],
    [{mode:'mjpeg',audio:{paused:true,muted:false,readyState:4}},'element_paused'],
    [{mode:'buffered_mjpeg',audio:{paused:false,muted:true,readyState:4}},'element_muted'],
    [{mode:'mjpeg',audio:{paused:false,muted:false,readyState:1}},'element_buffering'],
    [{mode:'mjpeg',audio:{muted:false,readyState:4}},'unknown'],
    [{mode:'mjpeg',audio:{paused:false,readyState:4}},'unknown'],
    [{mode:'mjpeg',audio:{paused:false,muted:false,readyState:4}},'element_playing_output_unverified'],
    [{mode:'native_video',video:{paused:false,muted:false,readyState:4,currentTime:5}},'element_playing_output_unverified'],
    [{mode:'native_video',video:{paused:true,muted:false,readyState:4,currentTime:5}},'element_paused'],
    [{mode:'webcodecs',audio:null},'unknown'],
    [{mode:'webcodecs',audio:{paused:false,muted:false,readyState:4}},'element_playing_output_unverified']
  ];
  for(const [input,expected] of cases){
    const state=snapshot(input);
    assert.equal(state.audio_observation,expected,JSON.stringify(input));
    assert.equal(Object.hasOwn(state,'audible'),false);
    assert.equal(Object.hasOwn(state,'speaker_output'),false);
  }
});
