"""Synthetic readability regressions; never reads personal image caches."""
import ast
import base64
import hashlib
import io
import pathlib
import sys
import tempfile
import types
import unittest
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '代码/项目/scripts'
sys.path.insert(0, str(SCRIPTS))
from wechat_image_normalize import normalize_image, MAX_BYTES, MAX_PIXELS


def png(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def function(filename, name, scope):
    tree = ast.parse((SCRIPTS / filename).read_text(encoding='utf-8-sig'))
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), scope)
    return scope[name]


class ImageQuality(unittest.TestCase):
    def decoded(self, result):
        raw = base64.b64decode(result['b64'], validate=True)
        self.assertEqual(result['bytes'], len(raw))
        self.assertLessEqual(len(raw), MAX_BYTES)
        self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())
        image = Image.open(io.BytesIO(raw))
        image.load()
        self.assertEqual(image.size, (result['width'], result['height']))
        return image

    def test_small_text_screenshot_stays_lossless_at_original_size(self):
        source = Image.new('RGB', (1920, 1080), 'white')
        draw = ImageDraw.Draw(source)
        for y in range(20, 1070, 17):
            draw.text((15, y), f'ROW {y}: ZX-4821 / qty 37 / price 128.50', fill='black')
        result = normalize_image(png(source))
        image = self.decoded(result)
        self.assertEqual(result['mime'], 'image/png')
        self.assertEqual(image.size, source.size)
        self.assertEqual(image.tobytes(), source.tobytes())

    def test_long_screenshot_retains_four_times_the_old_text_scale(self):
        source = Image.new('RGB', (1080, 6000), 'white')
        draw = ImageDraw.Draw(source)
        for y in range(10, 5990, 30):
            draw.text((20, y), f'ROW {y} REF A7B9C2', fill='black')
        result = normalize_image(png(source))
        image = self.decoded(result)
        self.assertGreater(image.height, 4700)
        self.assertGreater(image.width, 860)
        self.assertLessEqual(image.width * image.height, MAX_PIXELS)
        self.assertEqual((result['sourceWidth'], result['sourceHeight']), source.size)

    def test_transparency_is_composited_on_white_and_exif_is_respected(self):
        transparent = Image.new('RGBA', (40, 20), (0, 0, 0, 0))
        self.assertEqual(self.decoded(normalize_image(png(transparent))).getpixel((1, 1)), (255, 255, 255))
        source = Image.new('RGB', (80, 40), 'white')
        exif = Image.Exif(); exif[274] = 6
        output = io.BytesIO(); source.save(output, format='JPEG', exif=exif)
        result = normalize_image(output.getvalue())
        self.assertEqual(self.decoded(result).size, (40, 80))
        self.assertEqual((result['sourceWidth'], result['sourceHeight']), (40, 80))

    def test_long_image_detail_views_cover_every_pixel_with_overlap_at_full_text_scale(self):
        source = Image.new('RGB', (1080, 6000), 'white')
        result = normalize_image(png(source), include_details=True)
        self.assertEqual(len(result['details']), 3)
        previous_end = 0
        for view in result['details']:
            left, top, right, bottom = view['region']
            self.assertEqual((left, right), (0, 1080))
            self.assertLessEqual(top, previous_end)
            self.assertEqual(self.decoded(view).size, (1080, bottom - top))
            previous_end = bottom
        self.assertEqual(previous_end, 6000)
        self.assertNotIn('details', normalize_image(png(Image.new('RGB', (1920, 1080), 'white')), include_details=True))

    def test_photo_fits_existing_wire_budget_without_format_mismatch(self):
        source = Image.effect_noise((1800, 1400), 60).convert('RGB')
        result = normalize_image(png(source))
        self.assertEqual(result['mime'], 'image/jpeg')
        self.decoded(result)

    def test_horizontal_details_cover_source_and_preserve_each_crop_content(self):
        source = Image.new('RGB', (6000, 1080), 'white')
        draw = ImageDraw.Draw(source)
        for left, color in ((0, 'red'), (2000, 'green'), (4000, 'blue')):
            draw.rectangle((left, 0, left + 1999, 1079), fill=color)
            draw.text((left + 20, 50), f'REGION {left}', fill='black')
        result = normalize_image(png(source), include_details=True)
        previous_end = 0
        for view in result['details']:
            left, top, right, bottom = view['region']
            self.assertEqual((top, bottom), (0, 1080))
            self.assertLessEqual(left, previous_end)
            crop = self.decoded(view)
            self.assertEqual(crop.size, (right - left, 1080))
            self.assertEqual(crop.tobytes(), source.crop(tuple(view['region'])).tobytes())
            previous_end = right
        self.assertEqual(previous_end, source.width)

    def test_animated_sticker_keeps_the_bounded_contact_sheet(self):
        frames = [Image.new('RGB', (100, 200), color) for color in ('red', 'green', 'blue')]
        output = io.BytesIO()
        frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
        result = normalize_image(output.getvalue(), animated=True)
        self.assertEqual(self.decoded(result).size, (300, 200))
        self.assertEqual(result['mime'], 'image/jpeg')

    def test_original_resource_later_than_thumbnail_is_chosen_and_bound_to_ids(self):
        with tempfile.TemporaryDirectory(prefix='xzs-image-copies-') as directory:
            attach = pathlib.Path(directory); images = attach / '2026-10/Img'; images.mkdir(parents=True)
            first, second, unrelated = 'a' * 32, 'b' * 32, 'c' * 32
            copies = {first + '_t.dat': png(Image.new('RGB', (160, 240), 'red')),
                      second + '.dat': png(Image.new('RGB', (800, 1200), 'white')),
                      second + '_h.dat': png(Image.new('RGB', (1400, 2200), 'white')),
                      unrelated + '_h.dat': png(Image.new('RGB', (2000, 2000), 'blue'))}
            for name in copies: (images / name).write_bytes(b'synthetic-encrypted-copy')
            reads = []
            def decode(filename, *_):
                reads.append(pathlib.Path(filename).name)
                return (copies[pathlib.Path(filename).name], 'png')
            scope = dict(Image=Image, io=io, normalize_image=normalize_image,
                         media=types.SimpleNamespace(MAX_EMBED_SIZE=8*1024*1024, decode_wechat_v2=decode))
            resolve = function('resolve-wechat-image.py', 'resolve_local_image', scope)
            result = resolve(attach, [first, second], [(1, b'synthetic-key')])
            self.assertEqual(self.decoded(result).size, (1400, 2200))
            self.assertEqual(result['sourceVariant'], 'full')
            self.assertFalse(any(name.startswith(unrelated) for name in reads))
            # A corrupt larger copy must still allow the usable exact-message copy.
            copies[second + '_h.dat'] = b'broken image'
            self.assertEqual(self.decoded(resolve(attach, [first, second], [(1, b'key')])).size, (800, 1200))
            result = resolve(attach, [first], [(1, b'key')])
            self.assertEqual(result['sourceVariant'], 'thumbnail')

    def test_old_or_thumbnail_cache_is_retried_without_affecting_stickers(self):
        current = function('reader-api.py', 'current_image_cache', {})
        self.assertFalse(current({'width': 1280}, 3))
        self.assertFalse(current({'normalizationVersion': 'readable-v2', 'sourceVariant': 'full'}, 3))
        self.assertFalse(current({'normalizationVersion': 'readable-v3', 'sourceVariant': 'thumbnail'}, 3))
        self.assertTrue(current({'normalizationVersion': 'readable-v3', 'sourceVariant': 'full'}, 3))
        self.assertTrue(current({}, 47))


if __name__ == '__main__':
    unittest.main()
