import { createOrb } from './orb'
import { STATES, type OrbState } from './state'

const app=document.getElementById('app')!
const title=document.createElement('h1');title.textContent='HERMES  /  ORB GALLERY';app.append(title)
const toolbar=document.createElement('div');toolbar.className='toolbar';app.append(toolbar)
const picker=document.createElement('select');for(const s of STATES){const option=document.createElement('option');option.value=s;option.textContent=s.toUpperCase();picker.append(option)}
const pickerLabel=document.createElement('label');pickerLabel.textContent='State  ';pickerLabel.append(picker);toolbar.append(pickerLabel)
const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='1';slider.step='.01';slider.value='0'
const levelLabel=document.createElement('label');levelLabel.textContent='Fake level  ';levelLabel.append(slider);toolbar.append(levelLabel)
const toggle=document.createElement('button');toggle.textContent='Light background';toolbar.append(toggle)
const grid=document.createElement('div');grid.className='grid';app.append(grid)
const tiles: {state:OrbState;orb:ReturnType<typeof createOrb>;element:HTMLElement}[]=[]
for(const state of STATES){
  const tile=document.createElement('div');tile.className='tile';grid.append(tile)
  const stage=document.createElement('div');stage.className='stage';tile.append(stage)
  const label=document.createElement('div');label.className='label';label.textContent=state.toUpperCase();tile.append(label)
  const fps=document.createElement('span');fps.className='fps';label.append('  ·  ',fps)
  const orb=createOrb(stage,{initial:state,onFps:value=>fps.textContent=`${value.toFixed(0)} fps`})
  tiles.push({state,orb,element:tile})
}
picker.addEventListener('change',()=>{for(const {orb} of tiles)orb.setState(picker.value as OrbState)})
slider.addEventListener('input',()=>{for(const {orb} of tiles)orb.setLevel(Number(slider.value))})
toggle.addEventListener('click',()=>{for(const {element} of tiles)element.classList.toggle('light');toggle.textContent=tiles[0].element.classList.contains('light')?'Dark background':'Light background'})
document.addEventListener('visibilitychange',()=>{for(const {orb} of tiles)orb.setVisible(!document.hidden)})
