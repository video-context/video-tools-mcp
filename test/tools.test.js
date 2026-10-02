import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { buildContext, detectShots, extractFrames, getKeyframes, getMetadata } from '../dist/tools.js'

const dir = mkdtempSync(join(tmpdir(), 'video-tools-mcp-test-'))
const video = join(dir, 'three-shots.mp4')

// A 6-second test video: 2s of red, 2s of blue, then 2s of a test pattern.
// It has a keyframe every second and a sine-wave audio track.
before(() => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', video,
  ])
})

test('getMetadata reads the streams', async () => {
  const { duration, media } = await getMetadata(video)
  assert.ok(Math.abs(duration - 6) < 0.1, `duration ${duration}`)
  assert.equal(media.video.codec, 'h264')
  assert.equal(media.video.width, 640)
  assert.equal(media.video.height, 360)
  assert.equal(media.video.fps, 30)
  assert.equal(media.audio.codec, 'aac')
})

test('detectShots finds the two cuts', async () => {
  const { shots, cuts } = await detectShots(video)
  assert.equal(cuts.length, 2, `cuts ${cuts}`)
  assert.ok(Math.abs(cuts[0] - 2) < 0.1)
  assert.ok(Math.abs(cuts[1] - 4) < 0.1)
  assert.equal(shots.length, 3)
  assert.equal(shots[0].start, 0)
})

test('getKeyframes finds a keyframe every second', async () => {
  const { keyframes, interval, notes } = await getKeyframes(video)
  assert.equal(keyframes.length, 6)
  assert.equal(interval.max, 1)
  assert.match(notes[0], /good/)
})

test('extractFrames writes JPEG files', async () => {
  const frames = await extractFrames(video, { times: [1, 3], width: 128, outDir: dir })
  assert.equal(frames.length, 2)
  for (const f of frames) assert.ok(existsSync(f.path))
  const even = await extractFrames(video, { count: 3, outDir: dir })
  assert.deepEqual(even.map((f) => f.t), [1, 3, 5])
})

test('buildContext returns a schema document', async () => {
  const doc = await buildContext(video)
  assert.equal(doc.schema_version, '0.1')
  assert.equal(doc.shots.length, 3)
  assert.equal(doc.keyframes.length, 6)
  assert.equal(doc.provenance[0].source, 'ffmpeg')
})

test('a missing file gives a clear error', async () => {
  await assert.rejects(getMetadata(join(dir, 'missing.mp4')), /ffprobe failed/)
})

test('the MCP server lists and runs the tools', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../dist/index.js', import.meta.url).pathname] })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['check_keyframes', 'detect_shots', 'extract_frames', 'video_context', 'video_metadata'])

    const frames = await client.callTool({ name: 'extract_frames', arguments: { input: video, count: 2, width: 128 } })
    assert.equal(frames.content.filter((c) => c.type === 'image').length, 2)

    const missing = await client.callTool({ name: 'video_metadata', arguments: { input: join(dir, 'missing.mp4') } })
    assert.equal(missing.isError, true)
  } finally {
    await client.close()
  }
})
