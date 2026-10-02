# video-tools-mcp

**An MCP server that gives AI agents local video tools.** Claude, Cursor, and other MCP clients can read video metadata, find shots and cuts, extract frames to look at, and check keyframes. The tools run FFmpeg on your machine. You do not need an API key, and the server does not upload your video anywhere.

| Tool | What it does |
| --- | --- |
| `video_metadata` | Reads the duration, container, codecs, resolution, frame rate, rotation, bitrate, and audio facts. |
| `detect_shots` | Finds the camera cuts and returns each shot with a start and an end time. |
| `extract_frames` | Extracts JPEG frames at given times, or spread evenly, and returns the images to the agent. |
| `check_keyframes` | Lists the keyframe times and checks the interval for seeking, trimming, and HLS or DASH streaming. |
| `video_context` | Builds one JSON document with the media facts, shots, and keyframes in the open [Video Context schema](https://github.com/video-context/video-schema). |

Each tool accepts a local file path or an `http(s)` URL.

## Requirements

- Node.js 20 or later.
- FFmpeg and ffprobe on your `PATH`.
  - macOS: `brew install ffmpeg`
  - Ubuntu or Debian: `sudo apt install ffmpeg`
  - Windows: `winget install ffmpeg`

## Install

### Claude Code

```sh
claude mcp add video-tools -- npx -y github:video-context/video-tools-mcp
```

### Claude Desktop, Cursor, Windsurf, and other MCP clients

Add this to the MCP configuration file of your client:

```json
{
  "mcpServers": {
    "video-tools": {
      "command": "npx",
      "args": ["-y", "github:video-context/video-tools-mcp"]
    }
  }
}
```

For Claude Desktop, the file is `claude_desktop_config.json`. For Cursor, the file is `.cursor/mcp.json`.

## Example prompts

- "Look at `~/Movies/demo.mp4` and tell me what happens in it."
- "Find the cuts in `launch.mp4` and list each shot with its length."
- "Get 8 frames from this video and write alt text for each one."
- "Will `ad.mp4` stream well with HLS? Check the keyframes."
- "Make a Video Context JSON file for every video in this folder."

## Example output

`video_context` returns a document like this one (illustrative):

```json
{
  "schema_version": "0.1",
  "video_id": "launch.mp4",
  "duration": 15,
  "media": {
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "video": { "codec": "h264", "width": 1280, "height": 720, "fps": 30, "pixel_format": "yuv420p" }
  },
  "shots": [
    { "start": 0, "end": 3 },
    { "start": 3, "end": 6 }
  ],
  "keyframes": [0, 3, 6],
  "provenance": [{ "source": "ffmpeg", "tracks": ["shots", "keyframes"] }]
}
```

## How it works

- `video_metadata` runs `ffprobe -show_format -show_streams`.
- `detect_shots` runs the FFmpeg `select='gt(scene,0.3)'` filter on a small copy of each frame. Change `threshold` to find more or fewer cuts.
- `check_keyframes` reads the packet flags with ffprobe. It does not decode the video, so it is fast.
- `extract_frames` seeks to each time and saves one JPEG. The files go to your temporary folder.

These tools find technical facts. They do not understand the content. To search many videos by meaning, or to get transcripts, on-screen text, objects, and summaries, see [Video Context](https://videocontextapi.com).

## Use the tools in code

```ts
import { buildContext, detectShots, extractFrames } from 'video-tools-mcp'

const { shots } = await detectShots('launch.mp4', { threshold: 0.25 })
const frames = await extractFrames('launch.mp4', { times: shots.map((s) => s.start) })
```

## Develop

```sh
npm install
npm test
```

The tests make a short video with FFmpeg, so FFmpeg must be installed.

## Related

- [video-schema](https://github.com/video-context/video-schema): the open JSON schema for video data, with converters from Google Video Intelligence, Amazon Rekognition, and Amazon Transcribe.
- [awesome-video-understanding](https://github.com/video-context/awesome-video-understanding): a list of video understanding APIs, models, tools, and datasets.
- [Free video tools in the browser](https://videocontextapi.com/tools/): scene detection, frame extraction, a keyframe checker, and a metadata viewer.

## License

MIT
