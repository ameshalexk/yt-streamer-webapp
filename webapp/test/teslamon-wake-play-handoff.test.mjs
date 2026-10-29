import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createTeslaMonLocalPlayer} from '../public/teslamon-local-player.js';

// Exercise the real search-result startup function and adapter together. Media
// transport is a fixture: this never starts FFmpeg, Chrome or a microphone.
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=app.indexOf('async function streamYoutubeSearchResult(');
const end=app.indexOf('\nasync function streamYoutubeHistoryItem(',start);
const adapter=fs.readFileSync(new URL('../public/ai-media-agent-adapter.js',import.meta.url),'utf8');

test('a movie requested after wake pause hands off buffering media without re-pausing it',async()=>{
  assert.ok(start>=0&&end>start,'actual app startup function is available');
  const classes=new Set(['playing','mjpeg-buffered-mode']);
  const screen={classList:{contains:name=>classes.has(name)}};
  const stats={state:'paused',renderedFrames:12,receivedFrames:12};
  const item={id:'ESABTN4VtrA',title:'Fixture movie',url:'https://www.youtube.com/watch?v=ESABTN4VtrA',duration:300};
  let releaseHistory,clock=0,pauses=0,starts=0;
  const context={
    location:{hostname:'stream.ameshalex.com',search:''},URLSearchParams,
    performance:{now:()=>clock},
    document:{querySelector:selector=>selector==='#screen'?screen:null},
    replayFn:()=>{},playbackPaused:false,streamAttempt:0,
    state:{youtubeSearchPlayingId:'oldfixture1',youtubeSearchResults:[item]},
    streamSeek:{duration:300},activeCompat:{bufferedPlayer:{getStats:()=>stats}},
    getStreamCurrentTime:()=>0,
    api:{get:async()=>({items:[item]})},
    beginNewPlaybackQuality(){},watchProgress:{stop:async()=>{}},
    watchResumePlan:()=>new Promise(resolve=>{releaseHistory=resolve;}),
    beginPlaybackStartupTrace:()=>null,refreshYoutubeMetadataInBackground(){},
    renderItems(){},renderLegacyLibrary(){},renderRecommendations(){},
    renderYoutubeSearch(){},renderYoutubeHistory(){},showAttemptedUrl(){},
    isMobileMode:()=>false,streamQuery:()=>'',audioQuery:()=>'',watchHistoryKey:()=>item.id,recordWatchHistory:async()=>{},
    pausePlayback(){pauses++;context.playbackPaused=true;stats.state='paused';},
    playStream(){
      starts++;context.playbackPaused=false;context.streamAttempt++;
      classes.add('loading');stats.state='buffering';stats.renderedFrames=0;stats.receivedFrames=0;
    },
  };
  vm.createContext(context);
  vm.runInContext(app.slice(start,end),context,{filename:'actual-search-startup.js'});
  vm.runInContext(adapter,context,{filename:'ai-media-agent-adapter.js'});
  const player=context.YTStreamerMediaAgent;
  const execute=player.execute;
  let unexpected;
  player.execute=async(...args)=>{try{return await execute(...args);}catch(error){unexpected=error;throw error;}};
  assert.equal((await player.execute('pause_for_voice')).status,'completed');
  assert.equal(context.playbackPaused,true);
  const coordinator=createTeslaMonLocalPlayer({getPlayer:()=>player,
    selectCandidate:async()=>({status:'selected',index:0})});
  const pending=coordinator.run({tool:'search_and_play',args:{query:'fixture movie'}});
  for(let n=0;n<10&&!releaseHistory;n++)await Promise.resolve();
  assert.equal(typeof releaseHistory,'function');
  assert.equal(starts,0,'history lookup has not started media yet');
  releaseHistory({position:0,restartProgress:false});
  const result=await pending;
  assert.ifError(unexpected);
  assert.equal(result.status,'accepted','buffering is a truthful handoff, not observed playing');
  assert.equal(result.playbackPhase,'buffering');
  assert.equal(starts,1);
  assert.equal(pauses,1,'the completed wake pause does not pause the requested movie again');
  assert.equal(context.playbackPaused,false);
  classes.delete('loading');stats.state='playing';stats.renderedFrames=1;stats.receivedFrames=2;clock=500;
  assert.equal(player.get_player_state().playback_phase,'playing','later real frame evidence remains possible');
  assert.equal(pauses,1);
});
