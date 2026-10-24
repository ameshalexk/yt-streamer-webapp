// Pure pose decision; the microphone controller remains the source of truth.
export function getTeslaMonPetMotion({wakeState='off',modelBusy=false,busy=false}={}){
  if(modelBusy||busy||wakeState==='processing')return 'running';
  if(wakeState==='recording')return 'alert';
  return 'sitting';
}
