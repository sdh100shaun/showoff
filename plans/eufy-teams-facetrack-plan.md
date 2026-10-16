# Plan: eufy E220 (P24) as a Teams camera, with AI face tracking

**Goal:** Use a **eufy Security Solo IndoorCam E220 (P24), 2K, Pan & Tilt** as a normal webcam in
Microsoft Teams, with face tracking that keeps the speaker framed. Build it on
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk).

Status: **draft / proposal**. Nothing here has been run against the hardware yet. Sections marked
**[verify]** are assumptions to check on the real device in Phase 0.

---

## 1. What the SDK gives us (and what it doesn't)

Taken from the SDK README and `docs/live-media.md`, `docs/ptz.md` and `docs/rtsp.md`:

| Need | SDK surface | Notes |
| --- | --- | --- |
| Login + session | `new EufyMega(...)`, `loginClient()` in `examples/_client.ts` | Supports captcha/2FA. Persistent session. Too many failed logins trigger a cooldown, so cache the session. |
| Find the camera | `eufy.getDevice(sn)`, `dev.describe()` (`examples/10-describe-device.ts`) | Devices are classified by what they report, with no per-model code. The P24 family shows up in the SDK as **T8410/T8411 "Indoor Cam Pan & Tilt"** (device type 31). **[verify]** the model code the E220 reports. |
| Live video | `dev.camera().live()` gives events: `video` (Annex-B access units, `h264`/`h265`), `video-config`, `audio`, `error` | One shared P2P pull feeds every consumer. Late joiners get the cached IDR straight away. Backpressure uses `pause()`/`resume()`. |
| Pipeable video | `cam.openReadable()` | A Node `Readable` of Annex-B bytes. The easiest way to feed ffmpeg's stdin. |
| fMP4 fragments | `cam.recordFragments()` | No dependencies. Useful for a browser/MSE preview UI. |
| Stills | `snapshotLive()` | Reuses the warm keyframe. Good for tests and for calibration. |
| Pan/tilt | `dev.ptz().rotate(dir)`, `left/right/up/down`, `preset().goto/save/...` | **Step-based only.** There is no absolute "go to angle", no position read-back, and preset writes are not acknowledged. `zoom` exists only on dual-lens models, so the E220 won't have it. |
| RTSP | `dev.rtsp()?.publish()` / `withdraw()` | Only present if the camera reports it. The standalone camera then serves RTSP on the LAN. **[verify]** whether the E220 has it. |
| Talkback | `cam.talkback()` | AAC-LC 16 kHz mono. Not needed for the MVP. |

**Things the design has to work around:**

1. **The source resolution changes mid-session.** It moves around a ladder (640×360 … 2560×1440),
   and a virtual camera has to show a *fixed* size. So we decode the stream, then scale or pad it
   to a constant output and rebuild the decoder on every `video-config` event.
2. **PTZ is open-loop.** We can't ask the camera "where are you", and each step's angle is unknown.
   We have to measure it (Phase 3).
3. **Latency.** P2P live video adds a delay, likely 0.3–1.5 s **[verify]**. PTZ commands take
   effect only after that delay, so a fast control loop would overshoot and oscillate.
4. **Audio has no stated sample rate.** The app assumes 16 kHz mono. Teams audio should keep using
   the laptop or headset mic, and camera audio stays optional.
5. **Node ≥ 24.5.0** is required. ffmpeg is needed to decode.

---

## 2. Target architecture

```
                    ┌──────────────────────────── host PC (Windows 11 / macOS) ───────────────────────────┐
 ┌──────────┐  P2P  │ ┌────────────────┐ Annex-B ┌──────────┐ raw BGR/NV12 ┌──────────────┐  frames  ┌────────────┐ │
 │ eufy E220│◀────▶│ │ eufy-bridge    │────────▶│ decoder  │─────────────▶│ framer       │─────────▶│ virtual cam│─┼─▶ Teams
 │ (P24)    │       │ │ (Node, SDK)    │         │ (ffmpeg) │              │ (crop/scale, │          │ sink       │ │
 └──────────┘       │ └───────▲────────┘         └──────────┘              │ fixed 1080p) │          └────────────┘ │
      ▲             │         │ ptz.rotate()                    │ downscaled └──────▲───────┘                         │
      │             │ ┌───────┴────────┐   face boxes  ┌────────▼────────┐          │ crop window                    │
      └─────────────┼─│ PTZ controller │◀──────────────│ face detector   │──────────┘                                │
        pan/tilt    │ └────────────────┘               │ (ONNX/MediaPipe)│                                           │
                    │                                  └─────────────────┘                                           │
                    └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Components

1. **`eufy-bridge`** (TypeScript, Node 24): logs in, caches the session, resolves the device,
   opens `live()`, and hands frames to the decoder. It handles `video-config` (by restarting the
   decoder), `error`, reconnects and shutdown. It also exposes a small local control API
   (HTTP/WebSocket on `127.0.0.1`) for status, PTZ, presets and tracking on/off.
2. **Decoder.** We spawn `ffmpeg -f h264|hevc -i pipe:0 -f rawvideo -pix_fmt nv12 pipe:1`.
   If the codec turns out to be H.265 on the E220 **[verify]**, we enable hardware decode
   (`-hwaccel d3d11va` / `videotoolbox`).
3. **Framer.** Keeps the output at a fixed **1920×1080 @ 30 fps** (fallback 1280×720). It does
   letterboxing and scaling, and it applies the *digital* crop window that auto-framing supplies.
   It re-times frames to a steady 30 fps by repeating the last frame if the source stalls, because
   Teams handles a steady cadence better than a jittery one.
4. **Virtual camera sink**, one per OS (see §3).
5. **Face detector.** Runs on a downscaled copy (e.g. 640×360) at 10–15 fps, not every frame.
6. **Tracking controller.** Merges digital auto-framing with mechanical pan/tilt (see §4).

### Language choice

- The bridge **must** be Node, because that's what the SDK is.
- Detection and framing can be **Node** (`onnxruntime-node` + `sharp`) or a **Python sidecar**
  (OpenCV + MediaPipe, talking over a pipe or shared memory). Recommendation: **stay in a single
  Node process** for the MVP (fewer moving parts) and use `onnxruntime-node` with **YuNet** or
  **BlazeFace** ONNX models. Move to a sidecar only if the CPU budget forces it.

---

## 3. Getting frames into Teams (virtual camera)

Teams can only use a device the OS lists as a camera, so we need a virtual camera. Options, in
order of preference:

| Approach | Platforms | Effort | Notes |
| --- | --- | --- | --- |
| **A. OBS Virtual Camera** (we feed OBS) | Win / macOS / Linux | Low | MVP route. The bridge serves an RTSP/SRT/UDP-TS stream (or the camera's own RTSP is used), OBS consumes it as a Media Source, and OBS Virtual Camera shows up in new Teams. This proves the whole chain before we write any driver code. |
| **B. Our own virtual camera (Windows 11)** | Windows 11 | Medium–High | Use `MFCreateVirtualCamera` (Media Foundation, Win11 22000+). New Teams (WebView2) enumerates MF virtual cameras. A small C++/Rust media source reads frames from shared memory written by the framer. |
| **B'. DirectShow filter** (e.g. `softcam`, Unity Capture) | Windows 10/11 | Medium | Classic Teams accepts it. New Teams support is patchy **[verify]**. Fallback only. |
| **C. CoreMediaIO Camera Extension** | macOS 12.3+ | Medium–High | A system extension that reads frames over XPC/IOSurface. It must be signed and notarized. |
| **D. v4l2loopback** | Linux | Low | `ffmpeg … -f v4l2 /dev/video10`. Teams on Linux is web-only (Chrome/Edge), and that works. Handy for CI and dev. |

**Plan:** use **A** (plus **D** for Linux dev) to reach a working Teams call quickly, then build
**B** as the first-class Windows target. Do **C** only if Mac users need it.

**Camera RTSP shortcut:** if `dev.rtsp()` exists on the E220, Phase 1 can point OBS straight at
the camera's RTSP URL and skip our decode path completely. Face tracking still needs frames,
though, so the bridge would then also pull RTSP (or `live()`) for detection. That doubles the
streams, so it isn't the long-term design.

---

## 4. Face tracking design

There are two levers, and the best result comes from using both together:

### 4a. Digital auto-framing ("Center Stage" style). The main lever.

- The E220 is 2K (2560×1440 or 2304×1296), so a 1080p or 720p output can **crop and follow** a
  face with no motor movement and no P2P command latency (only the video latency).
- Algorithm:
  1. Detect faces at 10–15 fps on a downscaled frame and keep a short-lived track ID per face
     (IoU/centroid tracker; SORT is enough).
  2. Pick the target: the largest or most central face, held with a "stickiness" period so the
     target doesn't flip between people. Option: frame **all** faces (union box with padding).
  3. Desired crop = target box × framing ratio (head plus shoulders, about a 2.5× face height
     vertically, rule-of-thirds eye line), clamped to the frame and to a **minimum crop size**
     (never zoom past about 2×, or it looks soft).
  4. Smooth with a critically damped spring or One-Euro filter on the crop centre and size. Add a
     **deadband** (ignore movement under about 3–5 % of frame width) so small head movements don't
     pan the shot.
  5. If no face is seen for N seconds, ease back to the wide shot.
- The crop window is handed to the framer, which scales it to the fixed output size.

### 4b. Mechanical pan/tilt. For when the person leaves the field of view.

- Trigger only when the **target crop presses against the sensor edge**, i.e. the person has moved
  out of what digital framing can reach.
- Because PTZ is step-based and open-loop with latency, the control loop is **step → wait →
  re-measure**:
  1. Send **one** `rotate(dir)` step (pan and tilt as separate commands).
  2. Wait for the latency (calibrated, e.g. 800 ms) plus the motor settle time, so detection sees
     the *new* view.
  3. Re-measure. Repeat only if the face is still outside the inner safe zone.
  4. Rate-limit (≤ 1 command per settle window) and stop after K steps in a row with no face found.
- **Calibration (Phase 3):** point the camera at a static scene or a checkerboard and send N steps.
  Measure the pixel shift per step with feature matching (ORB + RANSAC homography) to get the
  **pixels per step** for pan and tilt, plus the settle time and latency. Store the results per
  device.
- **Fighting the on-camera tracking:** eufy indoor cams have their own "motion tracking" setting.
  It must be **off** while our tracker is active, or the camera will fight us. **[verify]** whether
  the SDK exposes it as a capability. If not, the user turns it off in the eufy app, and the
  bridge checks for it and warns.
- **Home position:** at startup, `preset().goto(home)` if a preset is saved. Offer "save current as
  home" in the control UI.

### 4c. Detector choice

| Model | Runtime | Speed (CPU, 640×360) | Notes |
| --- | --- | --- | --- |
| **YuNet** (OpenCV Zoo) | ONNX | ~2–5 ms | Small and accurate, returns 5 landmarks. **Default.** |
| BlazeFace (MediaPipe short-range) | ONNX/TFLite | ~1–3 ms | Built for selfie range. Weaker at desk-to-room distance. |
| SCRFD-500M | ONNX | ~5–10 ms | Better for small or far faces. Fallback when the camera is on a shelf. |

- All processing happens **on the device**. No frames or face data leave the host.
- Optional later: a person/body detector, so tracking survives the person turning away.

---

## 5. Repository layout (proposed new project)

```
eufy-teams-cam/
├── packages/
│   ├── bridge/            # Node 24 + @mega-yfue/eufy-sdk: login, live(), PTZ, control API
│   │   ├── src/session.ts       # login/2FA, session cache, reconnect
│   │   ├── src/stream.ts        # live() → decoder; video-config handling; backpressure
│   │   ├── src/decoder.ts       # ffmpeg child process (hwaccel opt-in)
│   │   ├── src/framer.ts        # fixed-size output, crop window, frame pacing
│   │   ├── src/tracking/        # detector.ts, tracker.ts, autoframe.ts, ptz-controller.ts, calibrate.ts
│   │   ├── src/sinks/           # obs-feed.ts (SRT/UDP-TS), v4l2.ts, shm.ts (for native cams)
│   │   └── src/api.ts           # 127.0.0.1 HTTP/WS: status, ptz, presets, tracking toggles
│   ├── vcam-win/          # C++/Rust MF virtual camera (MFCreateVirtualCamera) reading shm
│   ├── vcam-mac/          # (later) CoreMediaIO camera extension
│   └── ui/                # tray app or small web UI: preview, tracking on/off, presets, calibrate
├── models/                # yunet.onnx (+ licence)
└── docs/
```

---

## 6. Phased delivery

### Phase 0: Hardware discovery (1–2 days)
- [ ] Log in with the SDK, then run `examples/10-describe-device.ts`. Record the model code,
      device type, capabilities (`ptz`, `rtsp`, `camera`, motion-tracking setting?) and whether
      `ptz.zoom` is present.
- [ ] Run `examples/04-ptz.ts` to confirm pan and tilt in all four directions, and presets.
- [ ] Use `live()` to capture 60 s. Log the codec, the `video-config` changes, fps, and
      end-to-end latency (film a stopwatch).
- [ ] Check whether RTSP publish works on the E220.
- **Exit:** a facts sheet (codec, resolution ladder, latency, PTZ step behaviour) that replaces
  every **[verify]** in this doc.

### Phase 1: MVP: camera in Teams (≈1 week)
- [ ] `bridge`: session cache, `live()`, ffmpeg decode, framer at a fixed 1080p30, rebuild on
      `video-config`.
- [ ] Sink: SRT/UDP-TS → OBS Media Source → OBS Virtual Camera. Linux: v4l2loopback.
- [ ] Reconnect on `error`/`stop`, with a "reconnecting…" slate frame instead of a frozen picture.
- **Exit:** a 30-minute Teams call with a stable 1080p picture and no frozen frames.

### Phase 2: Digital auto-framing (≈1 week)
- [ ] YuNet via `onnxruntime-node` on a downscaled stream at 10–15 fps.
- [ ] Tracker, target selection, smoothing (One-Euro), deadband and the "return to wide" behaviour.
- [ ] Control API toggles: off / follow one speaker / frame the group.
- **Exit:** the framing follows a person walking across the field of view without visible jitter.
  CPU use under about 25 % of one core on the reference laptop.

### Phase 3: Mechanical PTZ tracking (≈1 week)
- [ ] Calibration routine (pixels per step, settle time, latency), stored per device.
- [ ] Step-wait-measure controller that only triggers at the edge of the digital range. Rate
      limit plus a safety stop.
- [ ] Detect or warn about the camera's on-board motion tracking.
- [ ] Home preset on start and stop.
- **Exit:** a person who walks out of the wide field of view is reacquired within 3 s, with no
  oscillation (≤ 1 overshoot).

### Phase 4: Native virtual camera on Windows (≈2 weeks)
- [ ] An MF virtual camera (`vcam-win`) that reads NV12 frames from a shared-memory ring buffer.
- [ ] Installer and registration. Testing in new Teams, classic Teams, Teams in a browser, and the
      Windows Camera app.
- [ ] Remove the OBS dependency.
- **Exit:** "eufy E220" appears as a camera in new Teams without OBS installed.

### Phase 5: Polish (ongoing)
- [ ] Tray UI with preview, toggles, presets and calibration.
- [ ] Optional camera mic → virtual mic (16 kHz mono, VB-Cable/BlackHole). Off by default.
- [ ] macOS CoreMediaIO extension if there's demand.
- [ ] Privacy: an indicator while streaming, and the stream stops when the camera is not in use by
      any app (if the MF camera can report consumer state).

---

## 7. Testing strategy

- **Unit:** tracker, smoothing and the PTZ controller, fed synthetic face-box sequences (no
  hardware). Run the PTZ controller against a **simulated camera** (a virtual pan/tilt over a
  panorama image, with latency injected) so oscillation bugs show up in CI.
- **Recorded fixtures:** save `live()` Annex-B captures, including ones with resolution changes,
  and replay them through decoder → framer → detector.
- **Hardware-in-the-loop (manual):** a script with a checklist covering walk across, sit/stand,
  two people, leave and return, low light/IR mode, a 60-minute soak, and Wi-Fi drop/reconnect.
- **Teams matrix:** new Teams on Win11, Teams in a browser on Linux/macOS, and a fixed 30 fps
  output checked via Teams call health stats.

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| P2P latency too high for PTZ | Oscillation or sluggish tracking | Digital framing does the fine work. PTZ only for big moves, with step-wait-measure. |
| Resolution oscillation | Visible zoom pumping | Fixed output plus a normalised crop window (in source-relative coords, not pixels). |
| Cloud/login dependency | No camera if the eufy cloud or login fails | Session cache, back-off, clear error slate. Investigate whether the RTSP LAN path works with the cloud offline. |
| Vendor protocol changes | Bridge breaks after a firmware or app update | Pin the SDK version, follow its releases, keep recorded fixtures for regression tests. |
| H.265 decode cost | High CPU | Hardware decode (d3d11va/videotoolbox/vaapi). |
| New Teams rejects the virtual cam | No camera in Teams | OBS route as a fallback. MF virtual camera on Win11. |
| On-board motion tracking fights ours | Erratic movement | Detect and disable, or warn the user. |
| Privacy/legal | Face data | Local-only processing, no storage of frames or embeddings, clear on/off. The SDK is unofficial and not affiliated with Anker, so use it on owned devices only and respect eufy's terms. |

---

## 9. Open questions

1. Which model code does the E220 (P24) report: T8410/T8411 or a newer code? Does it support RTSP?
2. Host OS for the first release: Windows 11 only, or also macOS?
3. Default framing: single speaker or whole group?
4. Should the camera mic be offered to Teams, or is video-only fine?
5. Is the camera on a desk (close range, so BlazeFace is fine) or across a room (needs SCRFD)?

---

## 10. References

- eufy-sdk: <https://github.com/mega-yfue/eufy-sdk> and its docs at <https://mega-yfue.github.io/>
  (`live-media`, `ptz`, `rtsp`, `devices`, examples `04-ptz.ts`, `07-live-stream-battery-budget.ts`,
  `10-describe-device.ts`)
- Windows virtual camera: `MFCreateVirtualCamera` (Media Foundation, Windows 11)
- macOS: CoreMediaIO Camera Extensions (macOS 12.3+)
- Linux: `v4l2loopback`
- Face detection: YuNet (OpenCV Zoo), MediaPipe BlazeFace, SCRFD (InsightFace)
- Smoothing: One-Euro filter (Casiez et al., 2012)
