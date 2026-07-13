$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 5321
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

$mime = @{
  ".html"       = "text/html"
  ".css"        = "text/css"
  ".js"         = "application/javascript"
  ".png"        = "image/png"
  ".jpg"        = "image/jpeg"
  ".svg"        = "image/svg+xml"
  ".webmanifest" = "application/manifest+json"
  ".json"       = "application/json"
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $reqPath = $context.Request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($reqPath)) { $reqPath = "index.html" }
    $filePath = Join-Path $root $reqPath

    if (Test-Path $filePath -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $ext = [System.IO.Path]::GetExtension($filePath)
        $contentType = $mime[$ext]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $context.Response.ContentType = $contentType
        $context.Response.Headers.Add("Cache-Control", "no-store")
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $context.Response.StatusCode = 404
    }
    $context.Response.OutputStream.Close()
}
