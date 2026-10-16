import * as THREE from 'three'
import { PARAMS, ribbonPulse as nucleusPulse, smoothLevel, Spring, target, type OrbState, type Param } from './state'
import { ribbonGeometry, ringGeometry, strokeGeometry, strokeVertex } from './ribbon'
import { galaxyGeometry, PALETTE } from './galaxy'
import { FrameClock, VisualClock } from './frame-clock'


const vertex = `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`
const blending = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, depthWrite: false, transparent: true, side: THREE.DoubleSide } as const
const glow = (fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}) => new THREE.ShaderMaterial({ ...blending, uniforms, vertexShader: vertex, fragmentShader })
// Hue-preserving radiance shoulder: two additive nucleus layers stay below
// channel clipping, with gradients intact even at the sustained activity crest.
const nucleusShoulder = `float peak=max(max(c.r,c.g),c.b);c*=.48*(1.-exp(-peak/.48))/max(peak,.00001);`

// A camera-facing backing, not a canvas background: translucent navy body with a
// narrow smooth shadow edge. Its entire footprint stays inside the hit circle.
export function createBackdrop() {
  const size = 256, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1) * 1.12
    const feather = Math.max(0, Math.min(1, (radius - .9) / .22))
    const alpha = .75 * (1 - feather * feather * (3 - 2 * feather))
    const center = Math.pow(Math.max(0, 1 - radius / .95), 2)
    const brightness = 1 + .18 * center
    data.set([Math.round((3 + Math.round(7 * center)) * brightness), Math.round((8 + Math.round(12 * center)) * brightness), Math.round((22 + Math.round(30 * center)) * brightness), Math.round(alpha * 255)], (y * size + x) * 4)
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(2.24, 2.24), new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false
  }))
  backing.renderOrder = -3
  return backing
}

// Visual-only soft fringe just beyond the body, not the expanded ribbon.
export function createOuterShadow() {
  const size = 256, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1)
    const feather = Math.max(0, Math.min(1, (radius - .6) / .4))
    // Fringe only: don't stack another opaque layer beneath the body interior.
    const inner = Math.max(0, Math.min(1, (radius - .72) / .13))
    const alpha = .58 * inner * inner * (3 - 2 * inner) * (1 - feather * feather * (3 - 2 * feather))
    data.set([3, 8, 22, Math.round(alpha * 255)], (y * size + x) * 4)
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false
  }))
  shadow.renderOrder = -4
  return shadow
}

export function updateOuterShadow(shadow: THREE.Object3D, bodyScale: number) {
  shadow.scale.setScalar(1.18 * bodyScale)
}

export function updateBodyMotion(globe: THREE.Object3D, backing: THREE.Object3D, shadow: THREE.Object3D, halo: THREE.Object3D, scale: number, spin: number) {
  globe.scale.setScalar(scale); globe.rotation.y = spin
  backing.scale.setScalar(scale); halo.scale.setScalar(scale)
  updateOuterShadow(shadow, scale)
}

export function createSphereLattice() {
  const ico = new THREE.IcosahedronGeometry(1.002, 3)
  const wireframe = new THREE.WireframeGeometry(ico); ico.dispose()
  const geometry = strokeGeometry(wireframe.getAttribute('position').array);wireframe.dispose()
  const material = new THREE.ShaderMaterial({ ...blending, uniforms: { strength: { value: .45 }, saturation: { value: 1 }, brightness: { value: 1.18 }, resolution: { value: new THREE.Vector2(320,320) }, strokeWidth: { value: 2 } },
    vertexShader: strokeVertex,
    fragmentShader: `varying float facing;uniform float strength,saturation,brightness;void main(){if(facing<0.)discard;vec3 c=mix(vec3(.16,.18,.20),vec3(.12,.46,.90),saturation)*strength*.35*(.5+.5*facing)*brightness;gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));}` })
  return new THREE.Mesh(geometry, material)
}

// The fixed camera at +Z looks toward the origin. Split the animated torus into
// rear/front hemispheres; the body then occludes only projected rear overlap.
// Object-level transparent sorting cannot sort points within a single draw.
export function createRibbonFabric(band: number) {
  const geo = ribbonGeometry(band)
  // Two luminous blue fabrics; only band 1 retains the enhanced yellow-gold activity.
  const mat = new THREE.ShaderMaterial({ transparent:true,depthWrite:false, uniforms:{hemisphere:{value:1},time:{value:0},strength:{value:.55},pulse:{value:0},spread:{value:.25},audio:{value:0},amber:{value:.08},saturation:{value:1},blue:{value:new THREE.Color(.055,.43,.88)},ink:{value:new THREE.Color(PALETTE.ink)},orange:{value:new THREE.Color(1,.68,.025)},gold:{value:new THREE.Color(PALETTE.gold)},warm:{value:band===1?1:0}},
    vertexShader:`attribute float seed;varying float f,s,arcDepth;uniform float time,strength,pulse,spread,audio;
      void main(){float a=position.x,v=position.y,b=position.z;
        float wave=sin(a*5.+time*.7+b*.75+v*.8)*(.045+strength*.11+audio*.045)
          +sin(a*3.-time*.35+b*.95)*.035;
        float radial=sin(a*4.+time*.7+b*.75+v*.8)*(.045+strength*.11+audio*.045)
          +sin(a*6.-time*.35+b*.95)*.035;
        float radius=1.13+spread*.14+b*.045+radial*.4+v*.035;
        vec3 p=vec3(cos(a)*radius,v*(.1+spread*.12)*.8+wave*.8+sin(a)*radius*sin(.7),sin(a)*radius*cos(.7));
        // Fabric-only envelope reserves native-viewport headroom at full crest.
        p*=.97*(1.+pulse);p.y*=.92;
        arcDepth=p.z;f=(.65+.35*seed)*strength*mix(.5,.95,smoothstep(-.4,.4,p.z));s=seed;
        gl_PointSize=1.6+seed*.7;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader:`varying float f,s,arcDepth;uniform float hemisphere,amber,saturation,warm;uniform vec3 blue,ink,orange,gold;
      void main(){if(arcDepth*hemisphere<0. || (hemisphere<0. && arcDepth==0.))discard;
        float d=length(gl_PointCoord-.5)*2.;float mask=max(0.,1.-d*d);vec3 cool=mix(ink,blue,.45+s*.55);vec3 hot=mix(orange,gold,s*.22);float hotWeight=warm==0.?0.:smoothstep(1.-warm*amber-.08,1.-warm*amber+.08,s);vec3 c=mix(cool,hot,hotWeight);c=mix(vec3(.16),c,saturation);
        gl_FragColor=vec4(c,mask*f*.85);}` })
  const rearMat = mat.clone()
  // Share animated uniforms, but not the hemisphere selection.
  rearMat.uniforms = { ...mat.uniforms, hemisphere: { value: -1 } }
  const front = new THREE.Points(geo,mat), rear = new THREE.Points(geo,rearMat)
  front.renderOrder = 2; rear.renderOrder = -3.5
  // Buffer positions contain torus parameters, not their shader-deformed bounds.
  front.frustumCulled = false; rear.frustumCulled = false
  return { front, rear }
}

export function createCore() {
  const material = glow(`varying vec3 n,v;uniform float strength,saturation,brightness,whiteness;
    void main(){float facing=max(dot(normalize(n),normalize(v)),0.);
      vec3 blue=mix(vec3(.08,.12,.20),vec3(.025,.28,.72),saturation);
      float falloff=smoothstep(0.,.9,facing)*pow(facing,4.);
      vec3 c=mix(blue,mix(vec3(.30,.56,.86),vec3(.94,.97,1.),whiteness),pow(facing,3.))*falloff*strength*brightness;
      ${nucleusShoulder}
      gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));}`, { strength: { value: .55 }, saturation: { value: 1 }, brightness: { value: 2.5 }, whiteness: { value: 1 } })
  material.side = THREE.FrontSide
  material.vertexShader = `varying vec3 n,v;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);n=normalMatrix*normal;v=-mv.xyz;gl_Position=projectionMatrix*mv;}`
  return new THREE.Mesh(new THREE.SphereGeometry(.14, 48, 32), material)
}

export function createCoreGlow() {
  const uniforms = { strength: { value: .55 }, saturation: { value: 1 }, brightness: { value: 1.85 }, whiteness: { value: 1 } }
  return new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), glow(`
    varying vec2 vUv; uniform float strength,saturation,brightness,whiteness;
    void main(){vec2 q=(vUv-.5)*2.;float r=length(q);float a=atan(q.y,q.x);
      float swirl=sin(11.*r-3.*a)*sin(19.*r+5.*a);
      float center=pow(max(0.,1.-r),7.);float halo=exp(-r*8.)*.42;
      float tunnel=pow(max(0.,1.-r),2.)*(.08+.08*swirl);
      vec3 blue=mix(vec3(.08,.12,.20),vec3(.025,.28,.72),saturation);
      vec3 c=mix(blue,vec3(.94,.97,1.),whiteness*exp(-r*32.))*(center*1.2+halo+tunnel)*strength*brightness;
      ${nucleusShoulder}
      gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));
    }`, uniforms))
}

export interface OrbOptions { compact?: boolean; initial?: OrbState; level?: number; onFps?: (fps: number) => void }
export function createOrb(host: HTMLElement, options: OrbOptions = {}) {
  const width = host.clientWidth || 320, height = host.clientHeight || 320
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width, height)
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.NoToneMapping
  host.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(37, width / height, .1, 100)
  camera.position.set(0, 0, 5.1)
  const globe = new THREE.Group(); scene.add(globe)
  const backing = createBackdrop(); scene.add(backing)
  const outerShadow = createOuterShadow(); scene.add(outerShadow)
  let current: OrbState = options.initial ?? 'idle', level = options.level ?? 0, filtered = 0, visible = true
  const springs = Object.fromEntries(PARAMS.map(p => [p, new Spring(target(current)[p], p === 'scale' ? .4 : .18)])) as Record<Param, Spring>
  const P = () => Object.fromEntries(PARAMS.map(p => [p, springs[p].value])) as Record<Param, number>

  // Volume at the actual galaxy origin; supplementary halo never inherits spin.
  const core = createCore(), coreUniforms = core.material.uniforms
  globe.add(core)
  const coreGlow = createCoreGlow(); scene.add(coreGlow)

  // Fresnel shell, glass interior, and upper-right white specular glint.
  const shellUniforms = { rim: { value: .6 }, saturation: { value: 1 } }
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), glow(`
    varying vec3 n,v,p; uniform float rim,saturation;
    void main(){float fres=pow(1.-max(dot(normalize(n),normalize(v)),0.),3.);
      float glint=pow(max(dot(normalize(n),normalize(vec3(.38,.68,.64))),0.),72.);
      vec3 c=mix(vec3(.09,.12,.18),vec3(.04,.38,.86),saturation)*(fres*.75+ .015)*rim + vec3(.7,.82,1.)*glint*.45*rim;
      gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));
    }`, shellUniforms))
  // Shell needs transformed normal and view direction rather than quad UV.
  const shellMat = shell.material as THREE.ShaderMaterial
  shellMat.side = THREE.FrontSide
  shellMat.vertexShader = `varying vec3 n,v,p;void main(){vec4 mv=modelViewMatrix*vec4(position,1.); n=normalize(normalMatrix*normal);v=-mv.xyz;p=position;gl_Position=projectionMatrix*mv;}`
  shellMat.needsUpdate = true
  // Glass tint at the rim only; the interior backing owns body opacity.
  const glass = new THREE.Mesh(shell.geometry, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    vertexShader: shellMat.vertexShader,
    fragmentShader: `varying vec3 n,v,p;void main(){float rim=pow(1.-max(dot(normalize(n),normalize(v)),0.),3.);
      gl_FragColor=vec4(.025,.065,.19,.15*rim);}`
  }))
  glass.renderOrder = -2; globe.add(glass)
  globe.add(shell)

  const lattice = createSphereLattice(), latticeMat = lattice.material; globe.add(lattice)
  latticeMat.uniforms.resolution.value.set(width,height)
  // Stars occupy spiral arms and a volume halo, not geodesic grid vertices.
  const nodesGeo = galaxyGeometry()
  const nodesMat = new THREE.ShaderMaterial({ ...blending, uniforms: { time: { value: 0 }, strength: { value: .55 }, saturation: {value:1} },
    vertexShader: `attribute float seed,size;varying float twinkle,tint;uniform float time,strength;void main(){twinkle=(.65+.35*sin(time*(.5+seed)+seed*17.))*(.7+strength*.5);tint=seed;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=size*5./(-mv.z);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying float twinkle,tint;uniform float saturation;void main(){float r=length(gl_PointCoord-.5)*2.;vec3 star=mix(vec3(.22,.48,1.),vec3(.88,.94,1.),smoothstep(.2,.8,tint));star=mix(star,vec3(1.,.78,.35),step(.92,tint));vec3 c=mix(vec3(.35),star,saturation)*pow(max(0.,1.-r),1.6)*twinkle;gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));}`
  })
  globe.add(new THREE.Points(nodesGeo, nodesMat))

  // Single-line circular paths expanded by triangles to 2.1 CSS pixels.
  const rings: { group: THREE.Group; mat: THREE.ShaderMaterial }[] = []
  for (let j = 0; j < 3; j++) {
    const geo = ringGeometry(j)
    const mat = glow(`varying vec2 vUv;uniform float time,strength,amber,saturation;
      void main(){float phase=fract(vUv.x-time);float comet=pow(max(0.,1.-min(phase,1.-phase)*18.),3.);
      float wave=.55+.45*sin(vUv.x*6.283+time*1.2);vec3 cyan=vec3(.0,.47,.83),gold=vec3(1.,.79,.27);
      vec3 c=mix(vec3(.18),mix(cyan,gold,amber),saturation)*(wave*.65+comet*1.6)*strength;gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));}`, { time: {value:0},strength:{value:.7},amber:{value:j===1?1:0},saturation:{value:1},resolution:{value:new THREE.Vector2(width,height)},strokeWidth:{value:2.1} })
    mat.vertexShader=strokeVertex
    const group = new THREE.Group(), tilted = new THREE.Mesh(geo,mat); group.add(tilted)
    tilted.rotation.set([.45,-.65,.94][j], [.28,.52,-.45][j], [.1,.65,-.3][j])
    scene.add(group); rings.push({group,mat})
  }

  // Three 256×24 toroidal dot fabrics. GLSL vertex waves modulate spread and audio.
  const ribbons: { points: THREE.Points; rear: THREE.Points; mat: THREE.ShaderMaterial }[] = []
  for (let band = 0; band < 3; band++) {
    const {front,rear} = createRibbonFabric(band)
    scene.add(rear,front);ribbons.push({points:front,rear,mat:front.material})
  }

  const sparkGeo=new THREE.BufferGeometry(), sparkData=new Float32Array(150*3)
  for(let i=0;i<150;i++){const a=i*2.39996,r=.85+(i*37%100)/180;sparkData.set([Math.cos(a)*r,Math.sin(a)*r*.75,(i*13%43)/60-.35],i*3)}
  sparkGeo.setAttribute('position',new THREE.BufferAttribute(sparkData,3))
  sparkGeo.setAttribute('seed',new THREE.BufferAttribute(Float32Array.from({length:150},(_,i)=>i*.618),1))
  const sparkMat=new THREE.ShaderMaterial({ ...blending, uniforms:{time:{value:0},strength:{value:.1},saturation:{value:1}},
    vertexShader:`attribute float seed;uniform float time,strength;varying float f;void main(){float phase=fract(time*.18+seed);vec3 p=position*(1.+phase*.25);f=(1.-phase)*strength;gl_PointSize=2.+3.*f;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader:`varying float f;uniform float saturation;void main(){float d=length(gl_PointCoord-.5)*2.;vec3 c=mix(vec3(.18),mix(vec3(.0,.47,.83),vec3(1.,.58,.15),.65),saturation)*pow(max(0.,1.-d),2.)*f;gl_FragColor=vec4(c,max(max(c.r,c.g),c.b));}` })
  scene.add(new THREE.Points(sparkGeo,sparkMat))

  let request=0, previous=0, frames=0, lastFps=performance.now(), idleSince=performance.now()
  const frameClock = new FrameClock()
  const motion = new VisualClock()
  let fabricPulsePhase = 0
  function tick(now: number) {
    request=0
    if (!visible) return
    const inactive=['idle','muted','offline'].includes(current)
    // Keep spinning in every state; only offline (no backend) freezes, after its transition settles.
    if (current==='offline' && now-idleSince>2000) return
    if (!frameClock.due(now,inactive?30:60)) { request=requestAnimationFrame(tick);return }
    const dt=Math.min((now-previous)/1000 || 1/60,.05);previous=now
    const t=target(current)
    for(const p of PARAMS) springs[p].step(t[p],dt)
    const v=P();filtered=smoothLevel(filtered,level,dt)
    const oldSpin=motion.spin,oldOrbit=motion.orbit,oldRings=motion.rings
    motion.step(dt,v.ringSpeed,v.spin,v.ribbonSpeed)
    if(current==='offline'){
      motion.spin=oldSpin+(motion.spin-oldSpin)*.5
      motion.orbit=oldOrbit+(motion.orbit-oldOrbit)*.5
      motion.rings=oldRings+(motion.rings-oldRings)*.5
    }
    updateBodyMotion(globe,backing,outerShadow,coreGlow,v.scale,motion.spin)
    // The star retains its four-second clock; fabric integrates a separate phase.
    const pulse=Math.max(0,nucleusPulse(current==='approval'?'thinking':current,motion.body*.5,v.ribbon)-v.ribbon)
    const active=['listening','thinking','working','speaking','approval'].includes(current)
    const activity=Math.min(1,Math.max(0,(v.ribbonSpeed-.30)/.90)*.65+filtered*v.audioGain*.35)
    fabricPulsePhase+=dt*2*Math.PI*(.65+.70*activity)
    const fabricBreath=(1-Math.cos(fabricPulsePhase))*.5
    const fabricPulse=active?fabricBreath*(.06+.055*activity):0
    const ribbonStrength=v.ribbon+(active?fabricBreath*(.18+.14*activity):0)
    core.scale.setScalar(1+pulse*1.6)
    // Offline preserves the captured pre-edit muted galaxy (.30 core / .60 saturation).
    // Muted matches idle galaxy only; shell, lattice, rings and fabric stay muted.
    const galaxySaturation=current==='muted'?1:current==='offline'?.60:v.saturation
    const whiteness=current==='offline'?0:1
    coreUniforms.strength.value=v.core*(1+pulse*1.2);coreUniforms.saturation.value=galaxySaturation
    coreUniforms.whiteness.value=whiteness;coreUniforms.brightness.value=current==='offline'?2.1:2.5
    coreGlow.scale.setScalar(v.scale*(1+pulse*.8))
    coreGlow.material.uniforms.strength.value=v.core*.55*(1+pulse*1.2);coreGlow.material.uniforms.saturation.value=galaxySaturation
    coreGlow.material.uniforms.whiteness.value=whiteness;coreGlow.material.uniforms.brightness.value=current==='offline'?1.65:1.85
    shellUniforms.rim.value=v.rim; shellUniforms.saturation.value=v.saturation
    latticeMat.uniforms.strength.value=.4+v.lattice;latticeMat.uniforms.saturation.value=v.saturation
    nodesMat.uniforms.time.value=motion.body;nodesMat.uniforms.strength.value=v.core;nodesMat.uniforms.saturation.value=galaxySaturation
    rings.forEach(({group,mat},i)=>{mat.uniforms.time.value=motion.rings+i*.3;mat.uniforms.strength.value=v.rings;mat.uniforms.amber.value=i===1? Math.max(.3,v.amber):v.amber*.25;mat.uniforms.saturation.value=v.saturation;group.scale.setScalar(v.scale);group.rotation.y=motion.orbit})
    ribbons.forEach(({points,rear,mat})=>{points.visible=rear.visible=current!=='offline';mat.uniforms.time.value=motion.fabric;mat.uniforms.strength.value=ribbonStrength;mat.uniforms.pulse.value=fabricPulse;mat.uniforms.spread.value=v.ribbonSpread;mat.uniforms.audio.value=filtered*v.audioGain;mat.uniforms.amber.value=Math.min(.95,v.amber*(1+.25*activity));mat.uniforms.saturation.value=v.saturation})
    sparkMat.uniforms.time.value=motion.body;sparkMat.uniforms.strength.value=v.sparks;sparkMat.uniforms.saturation.value=v.saturation
    renderer.render(scene,camera)
    frames++;if(now-lastFps>=1000){options.onFps?.(frames*1000/(now-lastFps));frames=0;lastFps=now}
    request=requestAnimationFrame(tick)
  }
  request=requestAnimationFrame(tick)
  return {
    setState(state: OrbState) {if(state!==current)idleSince=performance.now();current=state;if(!request && visible)request=requestAnimationFrame(tick)},
    setLevel(value: number) {level=Math.max(0,Math.min(1,value))},
    setVisible(value: boolean) {visible=value;if(!value){cancelAnimationFrame(request);clearTimeout(request);request=0}else if(!request){previous=performance.now();request=requestAnimationFrame(tick)}},
    dispose() {visible=false;cancelAnimationFrame(request);clearTimeout(request);backing.material.map?.dispose();outerShadow.material.map?.dispose();scene.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.Points||o instanceof THREE.LineSegments){o.geometry.dispose();const m=o.material;if(Array.isArray(m))m.forEach(x=>x.dispose());else m.dispose()}});renderer.dispose();renderer.domElement.remove()}
  }
}
