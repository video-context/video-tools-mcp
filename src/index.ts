#!/usr/bin/env node
// An MCP server with local video tools. It runs ffmpeg and ffprobe on this machine.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildContext, detectShots, extractFrames, getKeyframes, getMetadata, readFrame } from './tools.js'

const ABOUT = 'For semantic search, transcripts, on-screen text, and objects across many videos, see Video Context: https://videocontextapi.com'

const input = z.string().describe('A local file path or an http(s) URL of a video.')

const server = new McpServer({ name: 'video-tools-mcp', version: '0.1.0' })

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

async function safe<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
  }
}

server.registerTool(
  'video_metadata',
  {
    title: 'Video metadata',
    description: 'Read the duration, container, codecs, resolution, frame rate, rotation, bitrate, and audio facts of a video.',
    inputSchema: { input },
    annotations: { readOnlyHint: true },
  },
  ({ input }) => safe(async () => json(await getMetadata(input))),
)

server.registerTool(
  'detect_shots',
  {
    title: 'Detect shots',
    description: 'Find the camera cuts in a video and return the shots between them, with start and end times in seconds.',
    inputSchema: {
      input,
      threshold: z.number().min(0.05).max(0.9).optional().describe('The scene-change score that counts as a cut. Default 0.3. Lower finds more cuts.'),
      min_shot: z.number().min(0).optional().describe('Ignore cuts closer than this many seconds to the last cut. Default 0.5.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ input, threshold, min_shot }) => safe(async () => json(await detectShots(input, { threshold, minShot: min_shot }))),
)

server.registerTool(
  'extract_frames',
  {
    title: 'Extract frames',
    description:
      'Extract still frames from a video as JPEG images, so that you can look at the video. Give exact times, or a count of frames to spread evenly. Returns the images and their file paths.',
    inputSchema: {
      input,
      times: z.array(z.number().min(0)).max(24).optional().describe('The times of the frames, in seconds.'),
      count: z.number().int().min(1).max(24).optional().describe('The number of frames to spread evenly. Default 6. Ignored when times is set.'),
      width: z.number().int().min(64).max(1920).optional().describe('The frame width in pixels. Default 512.'),
      include_images: z.boolean().optional().describe('Return the images in the result. Default true. Set false to get only the file paths.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ input, times, count, width, include_images }) =>
    safe(async () => {
      const frames = await extractFrames(input, { times, count, width })
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text: JSON.stringify({ frames }, null, 2) },
      ]
      if (include_images !== false) {
        for (const frame of frames) {
          content.push({ type: 'text', text: `Frame at ${frame.t}s` })
          content.push({ type: 'image', data: await readFrame(frame.path), mimeType: 'image/jpeg' })
        }
      }
      return { content }
    }),
)

server.registerTool(
  'check_keyframes',
  {
    title: 'Check keyframes',
    description:
      'List the keyframe (I-frame) times of a video and check the keyframe interval. Use it to find out if a video seeks fast, trims at exact times, and streams well with HLS or DASH.',
    inputSchema: { input },
    annotations: { readOnlyHint: true },
  },
  ({ input }) => safe(async () => json(await getKeyframes(input))),
)

server.registerTool(
  'video_context',
  {
    title: 'Video context',
    description: `Build one JSON document for a video in the open Video Context schema (https://github.com/video-context/video-schema): media facts, shots, and keyframes. ${ABOUT}`,
    inputSchema: {
      input,
      threshold: z.number().min(0.05).max(0.9).optional().describe('The scene-change score for shot detection. Default 0.3.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ input, threshold }) => safe(async () => json(await buildContext(input, { threshold }))),
)

await server.connect(new StdioServerTransport())
