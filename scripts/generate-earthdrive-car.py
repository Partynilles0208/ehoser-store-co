"""Generate the original E1 Touring mesh. Run from the repository root."""
import base64
import json
import math
import struct
from pathlib import Path

blob = bytearray()
views, accessors, meshes, nodes = [], [], [], []
materials = []
for name, color, metallic, roughness, glow in [
    ('Sea glass paint', [.13, .60, .49, 1], .48, .28, None),
    ('Midnight glass', [.045, .10, .14, 1], .6, .18, None),
    ('Tire rubber', [.026, .032, .03, 1], 0, .88, None),
    ('Satin alloy', [.65, .73, .72, 1], .8, .24, None),
    ('Charcoal trim', [.045, .063, .056, 1], .25, .42, None),
    ('LED headlights', [.9, 1, 1, 1], .1, .3, [.5, .7, .7]),
    ('Rear lights', [.8, .04, .025, 1], .1, .3, [.5, .015, .005]),
    ('Badge', [.76, .95, .82, 1], .65, .25, None),
]:
    mat = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': color, 'metallicFactor': metallic, 'roughnessFactor': roughness}}
    if glow:
        mat['emissiveFactor'] = glow
    materials.append(mat)


def attribute(data, width, component=5126):
    while len(blob) % 4:
        blob.append(0)
    start = len(blob)
    for value in data:
        blob.extend(struct.pack('<f' if component == 5126 else '<H', value))
    views.append({'buffer': 0, 'byteOffset': start, 'byteLength': len(blob) - start, 'target': 34963 if component == 5123 else 34962})
    item = {'bufferView': len(views) - 1, 'componentType': component, 'count': len(data) // width, 'type': {1: 'SCALAR', 3: 'VEC3'}[width]}
    if width == 3:
        item['min'] = [min(data[i::3]) for i in range(3)]
        item['max'] = [max(data[i::3]) for i in range(3)]
    accessors.append(item)
    return len(accessors) - 1


def mesh(vertices, faces, material):
    positions, normals, indices = [], [], []
    for face in faces:
        a, b, c = [vertices[i] for i in face[:3]]
        ab, ac = [[q - p for p, q in zip(a, point)] for point in (b, c)]
        n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        length = math.sqrt(sum(v*v for v in n)) or 1
        normal = [v / length for v in n]
        offset = len(positions) // 3
        for index in face:
            positions.extend(vertices[index])
            normals.extend(normal)
        for i in range(1, len(face)-1):
            indices.extend([offset, offset+i, offset+i+1])
    meshes.append({'primitives': [{'attributes': {'POSITION': attribute(positions, 3), 'NORMAL': attribute(normals, 3)}, 'indices': attribute(indices, 1, 5123), 'material': material}]})
    return len(meshes)-1


faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]


def box(name, size, position, material, parent=None):
    x, y, z = [v / 2 for v in size]
    vertices = [(-x,-y,-z), (x,-y,-z), (x,y,-z), (-x,y,-z), (-x,-y,z), (x,-y,z), (x,y,z), (-x,y,z)]
    index = len(nodes)
    nodes.append({'name': name, 'mesh': mesh(vertices, faces, material), 'translation': position})
    if parent is not None:
        nodes[parent].setdefault('children', []).append(index)
    return index


roots = []
roots.append(box('Chassis', [4.25,.27,1.92], [0,.49,0], 4))
roots.append(box('Body', [4.35,.44,1.9], [0,.76,0], 0))
roots.append(box('Bonnet', [1.35,.1,1.8], [1.44,1,0], 0))
roots.append(box('Tailgate', [.75,.12,1.84], [-1.75,1.0,0], 0))
roof = [(-1.2,1,-.86), (.92,1,-.86), (.35,1.58,-.70), (-.8,1.58,-.70), (-1.2,1,.86), (.92,1,.86), (.35,1.58,.70), (-.8,1.58,.70)]
roots.append(len(nodes)); nodes.append({'name': 'Cabin glazing', 'mesh': mesh(roof, faces, 1)})
roots.append(box('Roof', [1.25,.055,1.44], [-.22,1.61,0], 0))
for side in [-1, 1]:
    roots.append(box('B pillar', [.1,.55,.055], [-.17,1.28,side*.79], 4))
    roots.append(box('Mirror', [.3,.16,.22], [.45,1.18,side*1.02], 0))
    roots.append(box('Door handle', [.19,.035,.035], [-.5,.99,side*.96], 3))
    roots.append(box('Sill', [2.5,.12,.055], [-.05,.43,side*.975], 3))
    roots.append(box('Headlamp', [.035,.12,.54], [2.19,.86,side*.55], 5))
    roots.append(box('Tail lamp', [.035,.10,.55], [-2.19,.88,side*.54], 6))
roots.append(box('Front grille', [.04,.20,.82], [2.20,.56,0], 4))
roots.append(box('Rear bumper', [.055,.16,1.8], [-2.20,.51,0], 4))
roots.append(box('Number plate', [.03,.13,.37], [-2.23,.72,0], 7))


def cylinder(radius, depth, material):
    count = 24
    vertices = [(radius*math.cos(i*math.tau/count), radius*math.sin(i*math.tau/count), z) for z in [-depth/2, depth/2] for i in range(count)]
    fs = [list(reversed(range(count))), list(range(count, count*2))]
    fs += [[i, (i+1)%count, (i+1)%count+count, i+count] for i in range(count)]
    return mesh(vertices, fs, material)


tire, rim = cylinder(.35, .27, 2), cylinder(.23, .285, 3)
for x, axle in [(1.28, 'F'), (-1.29, 'R')]:
    for z, side in [(-.94, 'L'), (.94, 'R')]:
        parent = len(nodes)
        roots.append(parent)
        nodes.append({'name': f'wheel{axle}{side}', 'translation': [x,.35,z], 'children': [parent+1, parent+2]})
        nodes.append({'mesh': tire}); nodes.append({'mesh': rim})
        for i in range(5):
            angle = i*math.tau/5
            spoke = box('Wheel spoke', [.29,.035,.01], [0,0,(.149 if z > 0 else -.149)], 4, parent)
            nodes[spoke]['rotation'] = [0,0,math.sin(angle/2),math.cos(angle/2)]

# glTF uses +Z forward; the modelling coordinates above use +X forward.
# Keep named wheel nodes in their own local frame underneath this root.
model_root = len(nodes)
nodes.append({'name': 'E1 Touring', 'children': roots, 'rotation': [0, -math.sqrt(.5), 0, math.sqrt(.5)]})
gltf = {'asset': {'version': '2.0', 'generator': 'ehoser original E1 Touring generator'}, 'scene': 0,
        'scenes': [{'nodes': [model_root]}], 'nodes': nodes, 'meshes': meshes, 'materials': materials,
        'buffers': [{'byteLength': len(blob), 'uri': 'data:application/octet-stream;base64,'+base64.b64encode(blob).decode()}],
        'bufferViews': views, 'accessors': accessors}
Path('public/earthdrive/e1-touring.gltf').write_text(json.dumps(gltf, separators=(',', ':')), encoding='utf8')
print('Generated original E1 Touring:', len(nodes), 'nodes,', len(blob), 'geometry bytes')
