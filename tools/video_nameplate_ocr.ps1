param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    [string[]]$Members,

    [string]$MembersBase64,

    [Parameter(Mandatory = $true)]
    [string]$VideoUrl,

    [Nullable[double]]$VideoSeconds = $null,
    [string]$CapturedAt = $null
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($MembersBase64) {
    if ($Members) { throw 'Supply either Members or MembersBase64.' }
    $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MembersBase64))
    $Members = ConvertFrom-Json -InputObject $decoded
}
if (-not $Members -or @($Members).Count -lt 2) { throw 'A complete member roster is required.' }
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Await-Op($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1

    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

$resolvedPath = (Resolve-Path -LiteralPath $ImagePath).Path
$fileOperation = [Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)
$file = Await-Op $fileOperation ([Windows.Storage.StorageFile])
$streamOperation = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
$stream = Await-Op $streamOperation ([Windows.Storage.Streams.IRandomAccessStream])
$bitmap = $null

try {
    $decoderOperation = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
    $decoder = Await-Op $decoderOperation ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $language = [Windows.Globalization.Language]::new('ko')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if (-not $engine) {
        throw 'Korean Windows OCR is unavailable.'
    }

    $ocr = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = [string]$ocr.Text
    $matches = @(
        $Members | Where-Object {
            $name = $_
            if ($name -notmatch '^[가-힣]{2,4}$') {
                return $false
            }

            $characters = $name.ToCharArray() | ForEach-Object {
                [regex]::Escape([string]$_)
            }
            $pattern = '(?<![가-힣])' + ($characters -join '\s*') + '(?![가-힣])'
            return @($ocr.Lines | Where-Object { $_.Text -match $pattern }).Count -gt 0
        } | Select-Object -Unique
    )

    $candidate = $null
    $status = 'abstain'
    if ($matches.Count -eq 1) {
        $candidate = $matches[0]
        $status = 'unconfirmed_visible_text'
    }

    $result = [ordered]@{
        videoUrl = $VideoUrl
        videoSeconds = $VideoSeconds
        capturedAt = $CapturedAt
        ocrText = $text
        matchedMembers = $matches
        candidate = $candidate
        status = $status
        note = '제공된 전체 명부 내 화면 글자 후보이며 발화자 확정이 아닙니다. URL과 시각은 호출자가 기입했습니다.'
    }
    $result | ConvertTo-Json -Depth 4
}
finally {
    if ($stream) {
        $stream.Dispose()
    }
    if ($bitmap) {
        $bitmap.Dispose()
    }
}
