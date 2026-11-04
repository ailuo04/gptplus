"""Generate via the authenticated local gpt++ gateway; standard library only."""
import argparse
import base64
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request

# Up to four 24 MiB images, base64 expansion, and bounded gateway metadata.
MAX_RESPONSE_BYTES = 4 * 24 * 1024 * 1024 * 4 // 3 + 1024 * 1024


class ImagegenError(Exception):
    """A safe, user-facing diagnostic with no provider body or credentials."""
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    prompt = parser.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-file", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--resolution", choices=["1K", "2K", "4K"])
    parser.add_argument("--aspect-ratio", choices=["1:1", "4:3", "3:4", "16:9", "9:16"])
    parser.add_argument("--n", type=int, default=1, choices=range(1, 5))
    parser.add_argument("--quality", choices=["auto", "low", "medium", "high"])
    parser.add_argument("--background", choices=["auto", "opaque", "transparent"])
    args = parser.parse_args()
    text = args.prompt_file.read_text(encoding="utf-8-sig") if args.prompt_file else args.prompt
    if not text.strip() or len(text.strip()) > 32000:
        raise ImagegenError("提示词不能为空且不能超过 32000 字符")
    output = args.output.expanduser().absolute()
    # Refuse existing candidates before any billable request.
    candidates = [output.with_suffix("." + fmt) for fmt in ("png", "jpg", "webp")]
    if args.n > 1:
        candidates = [p.with_name(p.stem + "-" + str(i + 1) + p.suffix)
                      for p in candidates for i in range(args.n)]
    if output.exists() or any(p.exists() for p in candidates):
        raise ImagegenError("输出文件已存在，请选择新的文件名；未发送生图请求")
    locator = json.loads((Path(__file__).resolve().parents[1] / "bridge.json").read_text(encoding="utf-8-sig"))
    config = json.loads(Path(locator["configPath"]).read_text(encoding="utf-8-sig"))
    plugin = config.get("plugins", {}).get("custom-imagegen", {})
    if not plugin.get("installed") or not plugin.get("enabled"):
        raise ImagegenError("自定义生图插件未启用")
    gateway = config.get("gateway", {})
    if not gateway.get("enabled") or not gateway.get("token"):
        raise ImagegenError("请启动 gpt++ 的本地网关")
    port = int(gateway.get("port", 18120))
    if not 1 <= port <= 65535:
        raise ImagegenError("本地网关端口无效")
    payload = {"prompt": text.strip(), "n": args.n}
    if args.resolution:
        payload["resolution"] = args.resolution
    if args.aspect_ratio:
        payload["aspectRatio"] = args.aspect_ratio
    if args.quality:
        payload["quality"] = args.quality
    if args.background:
        payload["background"] = args.background
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(port) + "/gptplus/images/generations",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + gateway["token"]},
        method="POST",
    )
    # Never send local credentials through a configured HTTP proxy or a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=200) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        # Gateway messages are sanitized by the app; never print response bodies.
        raise ImagegenError("本地生图接口返回 HTTP " + str(error.code) + "；请检查插件配置与 gpt++ 状态，未切换提供商") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ImagegenError("无法连接本地生图接口或请求超时；请检查 gpt++ 和网关是否运行，未切换提供商") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ImagegenError("生图响应过大")
    result = json.loads(raw)
    images = result.get("data")
    if not isinstance(images, list) or not 1 <= len(images) <= args.n:
        raise ImagegenError("本地生图接口未返回有效图片")
    prepared = []
    for index, image in enumerate(images):
        fmt = image.get("format")
        if fmt not in ("png", "jpg", "webp"):
            raise ImagegenError("不支持的图片格式")
        data = base64.b64decode(image["b64_json"], validate=True)
        target = output.with_suffix("." + fmt)
        if args.n > 1:
            target = target.with_name(target.stem + "-" + str(index + 1) + target.suffix)
        prepared.append((target, data))
    output.parent.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        for target, data in prepared:
            with target.open("xb") as handle:
                created.append(target)
                handle.write(data)
    except OSError:
        for target in created:
            target.unlink(missing_ok=True)
        raise ImagegenError("保存图片失败或文件已存在；没有覆盖已有文件") from None
    print(json.dumps({"paths": [str(p) for p in created]}, ensure_ascii=False))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except ImagegenError as error:
        print("自定义生图失败：" + str(error), file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, KeyError, TypeError):
        # Keep unexpected local paths, encrypted configuration and credentials out of logs.
        print("自定义生图失败：请检查配置、网关、参数和输出路径；未切换提供商。", file=sys.stderr)
        sys.exit(1)
