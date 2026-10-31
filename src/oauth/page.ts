/**
 * 連携の結果を知らせる、簡単なブラウザのページ(OpenRouterとGitHubで使う)。
 * 見出しと本文には、固定の文字列だけを入れる(HTMLとして、そのまま埋め込むため)
 */
export function resultPage(
	status: number,
	title: string,
	message: string,
): Response {
	const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Bobert</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head>
<body>
<h1>${title}</h1>
<p>${message}</p>
</body>
</html>
`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			// URLにcodeが含まれるので、ほかのサイトに渡さない
			"Referrer-Policy": "no-referrer",
		},
	});
}
