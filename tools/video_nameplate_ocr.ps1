param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    [string[]]$Members,

    [string]$MembersBase64,

    [Parameter(Mandatory = $true)]
    [string]$VideoUrl,

    [Nullable[double]]$VideoSeconds = $null,
    [string]$CapturedAt = $null,
    [switch]$FullOnly,
    [switch]$IncludeLowerCrops,
    [string]$ExtraImagesBase64
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
$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapBounds, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
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
    $texts = @([string]$ocr.Text)
    $lines = @($ocr.Lines | ForEach-Object { $_.Text })
    $useCrops = -not $FullOnly -and ($CapturedAt -or $IncludeLowerCrops)
    if ($useCrops) {
      try {
        # Layout reference: 1280x720, left x=65,y=535,w=220,h=95;
        # mirror the rectangle for the right side. These are independent of identities.
        $width = [int]$decoder.PixelWidth
        $height = [int]$decoder.PixelHeight
        if ($width * $height -gt 16000000) { throw 'Image exceeds crop resource limit.' }
        $cropWidth = [int][Math]::Floor($width * 220 / 1280)
        $cropHeight = [int][Math]::Floor($height * 95 / 720)
        $left = [int][Math]::Floor($width * 65 / 1280)
        $top = [int][Math]::Floor($height * 535 / 720)
        $right = $width - $left - $cropWidth
        # Bound scaled decoding to 16 million pixels; 1280x720 can use 4x.
        $scale = [Math]::Max(1, [Math]::Min(4, [Math]::Floor([Math]::Sqrt(16000000 / ($width * $height)))))
        $cropXs = @($left, $right)
        if ($cropWidth -lt 1 -or $cropHeight -lt 1) {
            [Console]::Error.WriteLine('Image too small for nameplate crop; retaining full-frame result.')
            $cropXs = @()
        }
        foreach ($x in $cropXs) {
            $bounds = [Windows.Graphics.Imaging.BitmapBounds]::new()
            $bounds.X = [uint32]($x * $scale)
            $bounds.Y = [uint32]($top * $scale)
            $bounds.Width = [uint32]($cropWidth * $scale)
            $bounds.Height = [uint32]($cropHeight * $scale)
            $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
            $transform.Bounds = $bounds
            $transform.ScaledWidth = [uint32]($width * $scale)
            $transform.ScaledHeight = [uint32]($height * $scale)
            $cropBitmap = $null
            try {
                $operation = $decoder.GetSoftwareBitmapAsync(
                    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
                    $transform,
                    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
                    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
                )
                $cropBitmap = Await-Op $operation ([Windows.Graphics.Imaging.SoftwareBitmap])
                $cropOcr = Await-Op ($engine.RecognizeAsync($cropBitmap)) ([Windows.Media.Ocr.OcrResult])
                $texts += [string]$cropOcr.Text
                $lines += @($cropOcr.Lines | ForEach-Object { $_.Text })
            }
            catch {
                [Console]::Error.WriteLine('Nameplate crop OCR failed; retaining other successful regions.')
            }
            finally {
                if ($cropBitmap) { $cropBitmap.Dispose() }
            }
        }
      }
      catch {
        [Console]::Error.WriteLine('Nameplate crop setup failed; retaining full-frame result.')
      }
    }
    if ($ExtraImagesBase64 -and -not $FullOnly) {
      try {
        $extraJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExtraImagesBase64))
        $extraPaths = @((ConvertFrom-Json -InputObject $extraJson) | ForEach-Object { $_ })
        if ($extraPaths.Count -gt 3) { throw 'Too many extra crops.' }
        foreach ($extraPath in $extraPaths) {
          $extraStream = $null; $extraBitmap = $null
          try {
            $extraFile = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$extraPath)) ([Windows.Storage.StorageFile])
            $extraStream = Await-Op ($extraFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $extraDecoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($extraStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            if ([double]$extraDecoder.PixelWidth * [double]$extraDecoder.PixelHeight -gt 16000000) { throw 'Crop exceeds resource limit.' }
            $extraBitmap = Await-Op ($extraDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $extraOcr = Await-Op ($engine.RecognizeAsync($extraBitmap)) ([Windows.Media.Ocr.OcrResult])
            $texts += [string]$extraOcr.Text
            $lines += @($extraOcr.Lines | ForEach-Object { $_.Text })
          }
          catch { [Console]::Error.WriteLine('Additional nameplate crop OCR failed; retaining other regions.') }
          finally {
            if ($extraStream) { $extraStream.Dispose() }
            if ($extraBitmap) { $extraBitmap.Dispose() }
          }
        }
      }
      catch { [Console]::Error.WriteLine('Additional nameplate crops unavailable; retaining other regions.') }
    }
    $text = $texts -join "`n"
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
            return @($lines | Where-Object { $_ -match $pattern }).Count -gt 0
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
