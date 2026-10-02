// Video tools that run ffmpeg and ffprobe on this machine.
// The results use the Video Context schema: https://github.com/video-context/video-schema

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_BUFFER = 256 * 1024 * 1024

export const SCHEMA_VERSION = '0.1'
const round = (n: number) => Math.round(n * 1000) / 1000

export interface Span {
  start: number
  end: number
}

export interface Media {
  url?: string
  container?: string
  size_bytes?: number
  bitrate?: number
  video?: { codec?: string; width?: number; height?: number; fps?: number; rotation?: number; pixel_format?: string }
  audio?: { codec?: string; channels?: number; sample_rate?: number }
}

export interface VideoContext {
  schema_version: typeof SCHEMA_VERSION
  video_id?: string
  duration?: number
  media?: Media
  shots?: Span[]
  keyframes?: number[]
  provenance?: Array<{ source: string; tracks?: string[]; created_at?: string }>
}

async function ffprobe(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', ...args], { maxBuffer: MAX_BUFFER })
    return stdout
  } catch (error) {
    throw toolError(error, 'ffprobe')
  }
}

async function ffmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', ...args], { maxBuffer: MAX_BUFFER })
    return stderr
  } catch (error) {
    throw toolError(error, 'ffmpeg')
  }
}

function toolError(error: unknown, binary: string): Error {
  const e = error as { code?: string; stderr?: string; message?: string }
  if (e.code === 'ENOENT') {
    return new Error(`${binary} is not installed or not on PATH. Install FFmpeg from https://ffmpeg.org/download.html, then try again.`)
  }
  const detail = (e.stderr ?? e.message ?? '').trim().split('\n').slice(-3).join('\n')
  return new Error(`${binary} failed: ${detail}`)
}

function fraction(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [a, b] = value.split('/').map(Number)
  if (!a || !b) return undefined
  return round(a / b)
}

const num = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

// Reads the container and stream facts of a video file or URL.
export async function getMetadata(input: string): Promise<{ duration?: number; media: Media }> {
  const probe = JSON.parse(await ffprobe(['-print_format', 'json', '-show_format', '-show_streams', input]))
  const video = probe.streams?.find((s: { codec_type: string; disposition?: { attached_pic?: number } }) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
  const rotation = video?.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? num(video?.tags?.rotate)
  const media: Media = compact({
    url: input,
    container: probe.format?.format_name,
    size_bytes: num(probe.format?.size),
    bitrate: num(probe.format?.bit_rate),
    video: video
      ? compact({
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: fraction(video.avg_frame_rate) ?? fraction(video.r_frame_rate),
          rotation,
          pixel_format: video.pix_fmt,
        })
      : undefined,
    audio: audio ? compact({ codec: audio.codec_name, channels: audio.channels, sample_rate: num(audio.sample_rate) }) : undefined,
  })
  const duration = num(probe.format?.duration) ?? num(video?.duration)
  return { duration: duration !== undefined ? round(duration) : undefined, media }
}

export interface ShotOptions {
  // The scene-change score from 0 to 1 that counts as a cut. Lower finds more cuts.
  threshold?: number
  // Cuts closer than this many seconds to the previous cut are ignored.
  minShot?: number
}

// Finds cuts with the ffmpeg scene-change score, and returns the shots between them.
export async function detectShots(input: string, options: ShotOptions = {}): Promise<{ duration?: number; shots: Span[]; cuts: number[] }> {
  const threshold = options.threshold ?? 0.3
  const minShot = options.minShot ?? 0.5
  const { duration } = await getMetadata(input)
  const log = await ffmpeg(['-i', input, '-an', '-sn', '-dn', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'])
  const cuts: number[] = []
  for (const match of log.matchAll(/pts_time:\s*([\d.]+)/g)) {
    const t = round(Number(match[1]))
    const last = cuts[cuts.length - 1] ?? 0
    if (t - last >= minShot && (duration === undefined || duration - t >= minShot / 2)) cuts.push(t)
  }
  const end = duration ?? cuts[cuts.length - 1] ?? 0
  const bounds = [0, ...cuts, end]
  const shots: Span[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1]! > bounds[i]!) shots.push({ start: bounds[i]!, end: bounds[i + 1]! })
  }
  return { duration, shots, cuts }
}

// Lists the keyframe times from the packet flags. This does not decode the video, so it is fast.
export async function getKeyframes(input: string): Promise<{
  keyframes: number[]
  interval: { min?: number; max?: number; average?: number }
  notes: string[]
}> {
  const out = await ffprobe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input])
  const keyframes = out
    .split('\n')
    .map((line) => line.split(','))
    .filter(([t, flags]) => t && t !== 'N/A' && flags?.includes('K'))
    .map(([t]) => round(Number(t)))
    .sort((a, b) => a - b)
  const gaps = keyframes.slice(1).map((t, i) => round(t - keyframes[i]!))
  const interval = gaps.length
    ? { min: Math.min(...gaps), max: Math.max(...gaps), average: round(gaps.reduce((a, b) => a + b, 0) / gaps.length) }
    : {}
  const notes: string[] = []
  if (keyframes.length <= 1) notes.push('The video has one keyframe or none. Seeking and trimming will be slow or inexact.')
  if (interval.max !== undefined && interval.max > 10) notes.push(`The longest keyframe interval is ${interval.max}s. Seeking can be slow. Streaming services usually want 2s to 4s.`)
  if (interval.max !== undefined && interval.min !== undefined && interval.max - interval.min > 0.5) notes.push('The keyframe interval is not fixed. HLS and DASH segments can have uneven lengths.')
  if (interval.max !== undefined && interval.max <= 4 && notes.length === 0) notes.push('The keyframe interval is good for seeking and for streaming.')
  return { keyframes, interval, notes }
}

export interface FrameOptions {
  // The times, in seconds, of the frames to extract. If not set, `count` frames spread evenly.
  times?: number[]
  count?: number
  // The width of each frame in pixels. The height keeps the aspect ratio.
  width?: number
  outDir?: string
}

export interface Frame {
  t: number
  path: string
}

// Extracts JPEG frames at given times, or spread evenly over the video.
export async function extractFrames(input: string, options: FrameOptions = {}): Promise<Frame[]> {
  const width = options.width ?? 512
  let times = options.times
  if (!times?.length) {
    const { duration } = await getMetadata(input)
    if (!duration) throw new Error('The video duration is unknown. Pass the times of the frames.')
    const count = Math.max(1, options.count ?? 6)
    times = Array.from({ length: count }, (_, i) => round(((i + 0.5) * duration) / count))
  }
  const id = createHash('sha1').update(input).digest('hex').slice(0, 10)
  const outDir = options.outDir ?? join(tmpdir(), 'video-tools-mcp', id)
  await mkdir(outDir, { recursive: true })
  const frames: Frame[] = []
  for (const t of times) {
    const path = join(outDir, `frame-${t.toFixed(3)}.jpg`)
    // -ss before -i seeks fast to the nearest keyframe, then decodes to the exact time.
    await ffmpeg(['-y', '-ss', String(t), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', path])
    frames.push({ t, path })
  }
  return frames
}

export async function readFrame(path: string): Promise<string> {
  return (await readFile(path)).toString('base64')
}

// Builds one Video Context document with the media facts, the shots, and the keyframes.
export async function buildContext(input: string, options: ShotOptions = {}): Promise<VideoContext> {
  const [{ duration, media }, { shots }, { keyframes }] = await Promise.all([getMetadata(input), detectShots(input, options), getKeyframes(input)])
  return compact({
    schema_version: SCHEMA_VERSION,
    video_id: input,
    duration,
    media,
    shots,
    keyframes,
    provenance: [{ source: 'ffmpeg', tracks: ['shots', 'keyframes'], created_at: new Date().toISOString() }],
  })
}
