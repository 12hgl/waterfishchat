# 姘撮奔 Chat (Waterfish Chat)

杞婚噺绾у鎻愪緵鍟?AI 鑱婂ぉ缃戦〉锛孌ocker 涓€閿儴缃诧紝鏀寔鑷姩绌洪棽浼戠湢銆?
## 鐗规€?
- 澶?AI 鎻愪緵鍟嗘敮鎸侊紙OpenAI 鍏煎 API锛?- CF Turnstile 鐧诲綍淇濇姢
- 鑷姩绌洪棽浼戠湢锛堥粯璁?30 鍒嗛挓鏃犺闂嚜鍔ㄥ仠姝㈠鍣級
- 杞婚噺闀滃儚锛? 80MB锛?- 鏁版嵁鎸佷箙鍖栵紙SQLite 瀛樺偍閰嶇疆涓庡璇濓級

## 蹇€熼儴缃?
```bash
docker compose up -d
```

璁块棶 `http://localhost:8080`锛屽畬鎴愬垵濮嬪寲鍚戝鍚庡嵆鍙娇鐢ㄣ€?
## 鎵嬪姩鎷夊彇闀滃儚

```bash
docker pull ghcr.io/12hgl/waterfishchat:latest
docker pull ghcr.io/12hgl/waterfishchat:v1.0
```

## 閰嶇疆

| 鐜鍙橀噺 | 榛樿鍊?| 璇存槑 |
|---------|--------|------|
| `IDLE_TIMEOUT_MIN` | 30 | 绌洪棽浼戠湢鏃堕棿锛堝垎閽燂級 |
| `TURNSTILE_SITE_KEY` | - | Cloudflare Turnstile 绔欑偣瀵嗛挜 |
| `TURNSTILE_SECRET_KEY` | - | Cloudflare Turnstile 瀵嗛挜 |

## 浠撳簱

https://github.com/12hgl/waterfishchat
