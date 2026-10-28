"""Bounded images for native DSH input, with a separate small sticker preview."""
import base64,hashlib,io,math
from PIL import Image,ImageOps

NORMALIZATION_VERSION = 'readable-v3'
MAX_BYTES = 768 * 1024
MAX_PIXELS = 2048 * 2048
MAX_DIMENSION = 8192


def encode_readable(image):
    # Match DSH's native storage pixel budget. A long screenshot must not be
    # shrunk to a square preview's long edge before the model ever receives it.
    ratio = min(1, MAX_DIMENSION / max(image.size), (MAX_PIXELS / (image.width * image.height)) ** .5)
    if ratio < 1:
        image = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.Resampling.LANCZOS)
    for _ in range(12):
        output = io.BytesIO()
        image.save(output, format='PNG', optimize=True)
        if output.tell() <= MAX_BYTES:
            return image, output.getvalue(), 'image/png'
        # Preserve character edges/colour before reducing dimensions. Photos
        # typically need JPEG, while flat screenshots fit lossless PNG.
        for quality in (90, 82):
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=quality, subsampling=0, optimize=True)
            if output.tell() <= MAX_BYTES:
                return image, output.getvalue(), 'image/jpeg'
        image = image.resize((max(1, int(image.width * .8)), max(1, int(image.height * .8))), Image.Resampling.LANCZOS)
    raise RuntimeError('NORMALIZED_IMAGE_TOO_LARGE')


def encoded_view(image):
    image, data, mime = encode_readable(image)
    return {'b64': base64.b64encode(data).decode('ascii'), 'mime': mime,
            'width': image.width, 'height': image.height, 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def long_image_details(image):
    width, height = image.size
    length, short = max(image.size), min(image.size)
    if length <= 2400 or length / short < 2.5:
        return []
    count = min(3, math.ceil(length / 1800))
    span = min(length, math.ceil((length + 120 * (count - 1)) / count))
    result = []
    for index in range(count):
        start = round(index * (length - span) / (count - 1))
        region = (0, start, width, start + span) if height >= width else (start, 0, start + span, height)
        result.append({**encoded_view(image.crop(region)), 'region': list(region)})
    return result


def normalize_image(raw, animated=False, include_details=False):
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise RuntimeError('IMAGE_TOO_LARGE_OR_EMPTY')
    with Image.open(io.BytesIO(raw)) as source:
        if source.width * source.height > 40_000_000:
            raise RuntimeError('IMAGE_PIXEL_LIMIT')
        source_size = source.size
        if animated and getattr(source, 'is_animated', False):
            # Bound decoded pixels and frames. A static sheet conveys sampled
            # animation content without repeatedly sending entire animations.
            budget = min(128, max(1, 80_000_000 // (source.width * source.height)))
            count=min(getattr(source,'n_frames',1),budget)
            frames=[]
            for index in dict.fromkeys((0,(count-1)//2,count-1)):
                source.seek(index)
                frame = source.convert('RGBA')
                frame.thumbnail((384, 384))
                background = Image.new('RGB', frame.size, 'white')
                background.paste(frame, mask=frame.getchannel('A'))
                frames.append(background)
            image = Image.new('RGB', (sum(f.width for f in frames), max(f.height for f in frames)), 'white')
            x = 0
            for frame in frames:
                image.paste(frame, (x, 0)); x += frame.width
        else:
            oriented = ImageOps.exif_transpose(source).convert('RGBA')
            source_size = oriented.size
            image = Image.new('RGB', oriented.size, 'white')
            image.paste(oriented, mask=oriented.getchannel('A'))
        details = long_image_details(image) if include_details and not animated else []
        if animated:
            image.thumbnail((1280, 1280))
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=85, optimize=True)
            data = output.getvalue()
            if len(data) > MAX_BYTES:
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=65, optimize=True)
                data = output.getvalue()
            if len(data) > MAX_BYTES:
                raise RuntimeError('NORMALIZED_IMAGE_TOO_LARGE')
            mime = 'image/jpeg'
        else:
            image, data, mime = encode_readable(image)
        return {'b64': base64.b64encode(data).decode('ascii'), 'mime': mime,
            'width': image.width, 'height': image.height, 'bytes': len(data),
            'sourceWidth': source_size[0], 'sourceHeight': source_size[1],
            'normalizationVersion': NORMALIZATION_VERSION,
            **({'details': details} if details else {}),
            'sha256': hashlib.sha256(data).hexdigest()}

