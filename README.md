# 🎬 다중 영상 컷 편집기 (video-cutter)

영상을 **최대 5개** 넣고 각각 원하는 구간(시작~끝)만 잘라 저장하거나, 순서대로 **한 개의 MP4**로 합치는 컷 편집기.

- 웹(설치 없음): **https://anchirong9-arch.github.io/video-cutter/**
- PC(정확·빠름): 집 PC의 **통합 스튜디오 런처** → `영상 컷 편집기` (포트 `8768`)

## 두 가지 동작 모드

| 모드 | 조건 | 결과 | 특징 |
|---|---|---|---|
| **PC 서버 (ffmpeg)** | 집 PC에서 `실행하기.bat` 실행 중 | `.mp4` | 프레임 단위 정확 컷, 빠름, 첫 영상 크기로 리사이즈해 합치기 |
| **브라우저** | 그냥 페이지를 열었을 때 | `.webm` | 업로드 없이 브라우저 안에서 녹화 저장. 실제 재생 시간만큼 걸림 |

웹페이지는 열리자마자 `127.0.0.1:8770`(런처 허브) → `127.0.0.1:8768` 순서로 PC 서버를 찾고,
있으면 자동으로 ffmpeg 모드로 바뀝니다. 서버가 없으면 브라우저 모드로 안내합니다.

## 쓰는 법

1. 영상 1~5개를 드래그하거나 눌러서 고르기
2. 플레이어를 원하는 지점에서 멈추고 **현재 위치 → 시작점 / 끝점**, 또는 슬라이더·`MM:SS.s` 칸으로 직접 입력
3. 영상마다 **이 구간 자르기**, 또는 아래 **전체 합쳐서 저장** (위/아래 화살표로 순서 변경, 체크 해제로 합치기 제외)

## 로컬 서버 직접 실행

```bash
pip install imageio-ffmpeg        # ffmpeg 바이너리 동봉
python server.py                  # http://127.0.0.1:8768/ 자동 열림
python server.py --no-open --port 9000
```

`ffmpeg`가 PATH에 있으면 그걸 쓰고, 없으면 `imageio-ffmpeg`가 내려받은 바이너리를 씁니다.
`studio-launcher`의 `실행하기.bat`으로 켜면 `requirements.txt` 설치와 함께 자동 기동됩니다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | `{app:"video-cutter", ffmpeg, maxClips:5, ...}` |
| POST | `/api/upload?name=파일명` | 본문(`application/octet-stream`) = 영상 바이트 → `{id, duration, width, height, hasAudio}` |
| POST | `/api/cut` | `{id, start, end, name?}` → 자른 MP4 `{file:{url, name, size, duration}}` |
| POST | `/api/concat` | `{parts:[{id,start,end},...], name?}` → 합친 MP4 |
| GET | `/api/download/<fid>` | 결과·원본 내려받기(`attachment`, 한글 파일명 지원) |
| POST | `/api/forget?id=` | 업로드 파일 정리 |

- CORS + `Access-Control-Allow-Private-Network: true` 응답이라 GitHub Pages(https)에서 `127.0.0.1`로 바로 호출할 수 있습니다.
- `127.0.0.1`에만 열리므로 같은 네트워크의 다른 기기에서는 접속되지 않습니다. 파일은 이 PC 안에서만 처리됩니다.
- 컷: `-ss` 입력 시크 + libx264 재인코딩(CRF 20, veryfast) → 프레임 단위 정확. `mode:"fast"`면 무재인코딩(키프레임 기준, 빠름).
- 합치기: 해상도·fps·오디오 유무가 달라도 `scale+pad+fps=30+aac 48k`로 정규화한 뒤 `concat` 필터로 이어 붙입니다(무음 영상은 무음 트랙 추가).

## 제한

- 한 번에 5개, 파일당 1GB, 60분까지
- 합치기 결과는 첫 영상 기준 해상도(긴 쪽 최대 1920)로 정규화
- 작업 폴더(`jobs/`)는 6시간 뒤 / 최근 40개만 남기고 자동 정리
