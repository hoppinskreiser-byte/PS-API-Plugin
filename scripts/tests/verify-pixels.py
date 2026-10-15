from pathlib import Path
from PIL import Image, ImageChops
import sys
p = Path(__file__).parent / 'artifacts'
a = Image.open(p/'before.png').convert('RGB')
b = Image.open(p/'after.png').convert('RGB')
d = ImageChops.difference(a,b)
rect=(100,100,549,392)
out=d.copy();out.paste((0,0,0),rect)
assert out.getbbox() is None, 'Outside selection pixels changed'
print('PASS: outside-selection pixels unchanged')
import numpy as np
x=np.asarray(d.crop(rect))
print(f'Roundtrip MAE={x.mean():.3f}/255; max={x.max()}; difference bounds={d.getbbox()}')
if '--identity' in sys.argv:
    assert d.getbbox() is None, 'Identity roundtrip changed pixels'
    print('PASS: identity Photoshop roundtrip is pixel-exact')
