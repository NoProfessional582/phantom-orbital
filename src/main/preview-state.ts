import { STATES, type OrbState } from '../renderer/state'

export function previewState(args: string[]): OrbState | undefined {
  const value = args.find(arg => arg.startsWith('--state='))?.slice('--state='.length)
  return STATES.find(state => state === value)
}
