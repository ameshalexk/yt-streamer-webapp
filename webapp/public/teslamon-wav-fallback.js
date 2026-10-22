// Browser-only conversion of a complete short Safari recording into PCM WAV.
// Only used after the server rejects Safari's MP4 container. No transcription
// or external API; decoded samples remain in the current browser tab.
const LIMIT=5*1024*1024;
export async function convertTeslaMonAudioToWav(blob,{AudioContext:Context=globalThis.AudioContext||globalThis.webkitAudioContext}={}){
  if(typeof Context!=='function'||!blob||blob.size<128||blob.size>LIMIT)
    throw new Error('wav_fallback_unavailable');
  const context=new Context();
  try{
    const raw=await blob.arrayBuffer();
    const audio=await context.decodeAudioData(raw);
    const channels=audio?.numberOfChannels;
    const length=audio?.length;
    const rate=audio?.sampleRate;
    const duration=length/rate;
    if(!Number.isSafeInteger(channels)||channels<1||channels>2||
       !Number.isSafeInteger(length)||length<1||
       !Number.isSafeInteger(rate)||rate<8000||rate>96000||
       !Number.isFinite(duration)||duration<=0.1||duration>21||
       (44+length*2)>LIMIT)throw new Error('wav_fallback_invalid_audio');
    const tracks=Array.from({length:channels},(_,c)=>audio.getChannelData(c));
    if(tracks.some(track=>!track||track.length!==length))
      throw new Error('wav_fallback_invalid_audio');
    const output=new ArrayBuffer(44+length*2);
    const view=new DataView(output);
    const write=(pos,str)=>{for(let i=0;i<str.length;i++)view.setUint8(pos+i,str.charCodeAt(i));};
    write(0,'RIFF');view.setUint32(4,36+length*2,true);
    write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);
    view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);
    view.setUint16(32,2,true);view.setUint16(34,16,true);
    write(36,'data');view.setUint32(40,length*2,true);
    for(let i=0;i<length;i++){
      let sample=0;
      for(const track of tracks)sample+=track[i];
      sample=Math.max(-1,Math.min(1,sample/channels));
      view.setInt16(44+i*2,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);
    }
    return new Blob([output],{type:'audio/wav'});
  }finally{
    try{await context.close();}catch{/* Best effort only. */}
  }
}
