#!/usr/bin/env python3
"""
Inferno — 四名主力 Boss 的形体（ADR-0003：脚本即事实源）

古达 / 玻尔多 / 深渊监视者 / 沙力万。
关节空物体的局部位置与运行时 Pose 相同（Three.js Y-up），网格挂在关节下。
招式仍由代码转这些关节，不在这里做骨骼动画。

产出:
  web/public/assets/boss-gundyr.glb
  web/public/assets/boss-vordt.glb
  web/public/assets/boss-watchers.glb
  web/public/assets/boss-sulyvahn.glb

用法: blender -b -P tools/blender/build_bosses.py
"""
import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "web" / "public" / "assets"

# glTF 把 Blender Z-up 收成 Y-up：(x, y, z) -> (x, z, -y)
CONV = Matrix((
    (1, 0, 0, 0),
    (0, 0, 1, 0),
    (0, -1, 0, 0),
    (0, 0, 0, 1),
))


def three_matrix(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    """Three.js 物体矩阵：T · R(XYZ) · S。与 three.Euler('XYZ') 一致。"""
    x, y, z = rot
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    e, f = math.cos(z), math.sin(z)
    ae, af, be, bf = a * e, a * f, b * e, b * f
    r = Matrix((
        (c * e, -c * f, d, 0),
        (af + be * d, ae - bf * d, -b * c, 0),
        (bf - ae * d, be + af * d, a * c, 0),
        (0, 0, 0, 1),
    ))
    s = Matrix.Diagonal((*scale, 1.0))
    t = Matrix.Translation(Vector(loc))
    return t @ r @ s


def to_blender_vec(v):
    x, y, z = v
    return Vector((x, -z, y))


def blender_matrix(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    m = three_matrix(loc, rot, scale)
    return CONV.inverted() @ m @ CONV


def hex_rgb(h):
    return ((h >> 16) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)


# ---------------------------------------------------------------- 几何

def _box(w, h, d):
    x, y, z = w / 2, h / 2, d / 2
    verts = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    return verts, faces


def _cyl_y(rb, rt, h, seg=8):
    """沿 Y。rb 在 -h/2，rt 在 +h/2。半径近 0 时收成尖。"""
    def ring(r, y):
        if r < 1e-4:
            return None
        out = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            out.append((math.cos(a) * r, y, math.sin(a) * r))
        return out

    bot = ring(rb, -h / 2)
    top = ring(rt, h / 2)
    verts = []
    faces = []
    if bot and top:
        b0 = 0
        verts.extend(bot)
        t0 = len(verts)
        verts.extend(top)
        bc = len(verts)
        verts.append((0, -h / 2, 0))
        tc = len(verts)
        verts.append((0, h / 2, 0))
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((b0 + i, b0 + j, t0 + j, t0 + i))
            faces.append((bc, b0 + j, b0 + i))
            faces.append((tc, t0 + i, t0 + j))
    elif bot or top:
        base = bot or top
        y_tip = h / 2 if bot else -h / 2
        verts.extend(base)
        tip = len(verts)
        verts.append((0, y_tip, 0))
        for i in range(seg):
            j = (i + 1) % seg
            if bot:
                faces.append((tip, j, i))
            else:
                faces.append((tip, i, j))
        cap = len(verts)
        verts.append((0, -y_tip, 0))
        for i in range(seg):
            j = (i + 1) % seg
            if bot:
                faces.append((cap, i, j))
            else:
                faces.append((cap, j, i))
    return verts, faces


def _sphere(r, seg=12, ring=8):
    verts = [(0.0, r, 0.0)]
    for i in range(1, ring):
        phi = math.pi * i / ring
        y = math.cos(phi) * r
        rr = math.sin(phi) * r
        for j in range(seg):
            a = 2 * math.pi * j / seg
            verts.append((math.cos(a) * rr, y, math.sin(a) * rr))
    verts.append((0.0, -r, 0.0))
    faces = []
    for j in range(seg):
        faces.append((0, 1 + (j + 1) % seg, 1 + j))
    for i in range(ring - 2):
        for j in range(seg):
            a = 1 + i * seg + j
            b = 1 + i * seg + (j + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    last = len(verts) - 1
    base = 1 + (ring - 2) * seg
    for j in range(seg):
        faces.append((last, base + j, base + (j + 1) % seg))
    return verts, faces


def _torus_y(major, tube, seg=12, tseg=6):
    """箍在 Y 轴上的环（缠柄、盔缘）。"""
    verts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ca, sa = math.cos(a), math.sin(a)
        for j in range(tseg):
            b = 2 * math.pi * j / tseg
            cb, sb = math.cos(b), math.sin(b)
            rr = major + tube * cb
            verts.append((ca * rr, tube * sb, sa * rr))
    faces = []
    for i in range(seg):
        ii = (i + 1) % seg
        for j in range(tseg):
            jj = (j + 1) % tseg
            a = i * tseg + j
            b = i * tseg + jj
            c = ii * tseg + jj
            d = ii * tseg + j
            faces.append((a, d, c, b))
    return verts, faces


def _tube(pts, radii, seg=6):
    """沿折线的圆管。pts / radii 为 Three 空间。"""
    pts = [Vector(p) for p in pts]
    rings = []
    for i, p in enumerate(pts):
        if i == 0:
            d = pts[1] - pts[0]
        elif i == len(pts) - 1:
            d = pts[i] - pts[i - 1]
        else:
            d = pts[i + 1] - pts[i - 1]
        if d.length < 1e-6:
            d = Vector((0, 1, 0))
        d.normalize()
        up = Vector((0, 1, 0))
        if abs(d.dot(up)) > 0.85:
            up = Vector((1, 0, 0))
        side = d.cross(up).normalized()
        lift = side.cross(d).normalized()
        ring = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            ring.append(p + (side * math.cos(a) + lift * math.sin(a)) * radii[i])
        rings.append(ring)
    verts = [tuple(v) for ring in rings for v in ring]
    faces = []
    n = len(pts)
    for i in range(n - 1):
        for k in range(seg):
            kk = (k + 1) % seg
            a = i * seg + k
            b = i * seg + kk
            c = (i + 1) * seg + kk
            d = (i + 1) * seg + k
            faces.append((a, b, c, d))
    # 两端封口
    for tip, sign in ((0, 1), (n - 1, -1)):
        c = len(verts)
        verts.append(tuple(pts[tip]))
        for k in range(seg):
            kk = (k + 1) % seg
            a = tip * seg + k
            b = tip * seg + kk
            if sign > 0:
                faces.append((c, b, a))
            else:
                faces.append((c, a, b))
    return verts, faces


def _blade(y0, y1, width, thick, stations=6):
    """菱形截面的剑身，从 y0 收到 y1（一般 y1 更小，朝下）。"""
    ts = [i / (stations - 1) for i in range(stations)]
    # 根部先放开，中段保持，末端收到尖
    profile = [0.45, 1.0, 0.92, 0.62, 0.28, 0.04]
    if stations != 6:
        profile = [0.45 + (0.04 - 0.45) * (i / (stations - 1)) for i in range(stations)]
        profile[1] = 1.0
    verts = []
    for t, w in zip(ts, profile):
        y = y0 + (y1 - y0) * t
        hw = width * w
        tk = thick * (1 - 0.8 * t) + thick * 0.08
        verts.extend([
            (0, y, tk),
            (hw, y, 0),
            (0, y, -tk * 0.55),
            (-hw, y, 0),
        ])
    faces = []
    for i in range(stations - 1):
        for k in range(4):
            kk = (k + 1) % 4
            faces.append((i * 4 + k, i * 4 + kk, (i + 1) * 4 + kk, (i + 1) * 4 + k))
    faces.append((0, 3, 2, 1))
    tip = (stations - 1) * 4
    faces.append((tip, tip + 1, tip + 2, tip + 3))
    return verts, faces


def _lathe(profile, seg=12):
    """绕 Y 的旋转体。profile 是 (y, 半径)，从下到上。"""
    verts = []
    rings = []
    for y, r in profile:
        if r < 1e-4:
            rings.append([len(verts)])
            verts.append((0.0, y, 0.0))
            continue
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring.append(len(verts))
            verts.append((math.cos(a) * r, y, math.sin(a) * r))
        rings.append(ring)
    faces = []
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        if len(a) == 1:
            for k in range(len(b)):
                faces.append((a[0], b[(k + 1) % len(b)], b[k]))
        elif len(b) == 1:
            for k in range(len(a)):
                faces.append((b[0], a[k], a[(k + 1) % len(a)]))
        else:
            n = len(a)
            for k in range(n):
                kk = (k + 1) % n
                faces.append((a[k], a[kk], b[kk], b[k]))
    return verts, faces


def _grid(cols, rows, p_at):
    """p_at(c, r) -> (x, y, z)，c/r 为 0..1。双面布用。"""
    verts = []
    for r in range(rows + 1):
        for c in range(cols + 1):
            verts.append(p_at(c / cols, r / rows))
    faces = []
    def idx(r, c):
        return r * (cols + 1) + c
    for r in range(rows):
        for c in range(cols):
            faces.append((idx(r, c), idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c)))
    return verts, faces


def _skirt(top_r, bot_r, h, seg, theta0, theta_len):
    """上沿在 y=0 的开口锥筒，下摆到 -h。枢轴在腰。"""
    verts = []
    rings = []
    for y, r in ((0.0, top_r), (-h, bot_r)):
        ring = []
        for i in range(seg + 1):
            a = theta0 + theta_len * i / seg
            ring.append(len(verts))
            verts.append((math.cos(a) * r, y, math.sin(a) * r))
        rings.append(ring)
    faces = []
    a, b = rings
    for i in range(seg):
        faces.append((a[i], b[i], b[i + 1], a[i + 1]))
    return verts, faces


# ---------------------------------------------------------------- 场景工具

class Kit:
    def __init__(self, col):
        self.col = col
        self.mats = {}

    def mat(self, name, color, rough=0.82, metal=0.08, emission=None, strength=0.0, double=False):
        old = bpy.data.materials.get(name)
        if old is not None:
            bpy.data.materials.remove(old)
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        m.use_backface_culling = not double
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

        def put(pred, value):
            sock = next((i for i in bsdf.inputs if pred(i)), None)
            if sock is not None:
                sock.default_value = value

        put(lambda i: i.name in ("Base Color", "Base Colour"), (*color, 1.0))
        put(lambda i: "Roughness" in i.name, rough)
        put(lambda i: i.name.startswith("Metallic"), metal)
        if emission is not None and strength > 0:
            put(lambda i: i.name in ("Emission Color", "Emission Colour", "Emission"), (*emission, 1.0))
            put(lambda i: "Strength" in i.name and "Emission" in i.name, strength)
        self.mats[name] = m
        return m

    def empty(self, name, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        o = bpy.data.objects.new(name, None)
        o.empty_display_type = "PLAIN_AXES"
        o.empty_display_size = 0.02
        self.col.objects.link(o)
        if parent is not None:
            o.parent = parent
            o.matrix_parent_inverse = Matrix.Identity(4)
        o.matrix_local = blender_matrix(loc, rot, scale)
        return o

    def mesh(self, name, parent, mat, verts, faces, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), pivot=False):
        """pivot=False：把 loc/rot/scale 烘进顶点，物体保持单位矩阵（给会被动的关节用）。
        pivot=True：顶点留在局部空间，物体自己带着位移（披风、裙摆的摇摆枢轴）。"""
        if pivot:
            cooked = verts
            xform = blender_matrix(loc, rot, scale)
        else:
            m = three_matrix(loc, rot, scale)
            cooked = []
            for v in verts:
                p = m @ Vector((v[0], v[1], v[2], 1.0))
                cooked.append((p.x, p.y, p.z))
            xform = Matrix.Identity(4)
        bverts = [to_blender_vec(v) for v in cooked]
        me = bpy.data.meshes.new(name)
        me.from_pydata(bverts, [], faces)
        me.validate(verbose=False)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = False
        me.materials.append(mat)
        obj = bpy.data.objects.new(name, me)
        self.col.objects.link(obj)
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_local = xform
        return obj


class Bag:
    """同一关节、同一材质收成一个网格，避免一零件一次绘制。"""

    def __init__(self, kit, parent, prefix):
        self.kit = kit
        self.parent = parent
        self.prefix = prefix
        self.acc = {}

    def put(self, mat, verts, faces, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        vs, fs = self.acc.setdefault(mat, ([], []))
        m = three_matrix(loc, rot, scale)
        base = len(vs)
        for v in verts:
            p = m @ Vector((v[0], v[1], v[2], 1.0))
            vs.append((p.x, p.y, p.z))
        for f in faces:
            fs.append(tuple(i + base for i in f))

    def box(self, mat, w, h, d, loc=(0, 0, 0), rot=(0, 0, 0)):
        self.put(mat, *_box(w, h, d), loc, rot)

    def cyl(self, mat, rb, rt, h, loc=(0, 0, 0), rot=(0, 0, 0), seg=8):
        self.put(mat, *_cyl_y(rb, rt, h, seg), loc, rot)

    def sph(self, mat, r, loc=(0, 0, 0), scale=(1, 1, 1), seg=12, ring=8):
        self.put(mat, *_sphere(r, seg, ring), loc, (0, 0, 0), scale)

    def tube(self, mat, pts, radii, seg=6):
        self.put(mat, *_tube(pts, radii, seg))

    def flush(self):
        out = []
        for mat, (vs, fs) in self.acc.items():
            if not fs:
                continue
            out.append(self.kit.mesh(f"{self.prefix}_{mat.name}", self.parent, mat, vs, fs))
        return out


def _purge_objects(prefix_names):
    for obj in list(bpy.data.objects):
        if obj.name in prefix_names or obj.name.startswith("AX_"):
            bpy.data.objects.remove(obj, do_unlink=True)
    col = bpy.data.collections.get("AxisTest")
    if col is not None:
        bpy.data.collections.remove(col)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)


def boss_collection():
    col = bpy.data.collections.get("InfernoBosses")
    if col is None:
        col = bpy.data.collections.new("InfernoBosses")
        bpy.context.scene.collection.children.link(col)
    for obj in list(col.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    return col


def export_tree(root, filename):
    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)

    bpy.ops.object.select_all(action="DESELECT")
    sel(root)
    bpy.context.view_layer.objects.active = root
    path = OUT_DIR / filename
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
    )
    print(f"INFERNO_BOSS {filename} bytes={path.stat().st_size}")
    return path


# ---------------------------------------------------------------- 古达（放大前的局部空间，运行时再乘 formScale）

def build_gundyr(kit):
    stone = kit.mat("g_stone", hex_rgb(0x4a4e55), rough=0.78, metal=0.22)
    dark = kit.mat("g_dark", hex_rgb(0x2a2d32), rough=0.9, metal=0.12)
    steel = kit.mat("g_steel", hex_rgb(0x8f99a3), rough=0.42, metal=0.55)
    edge = kit.mat("g_edge", hex_rgb(0x6a5344), rough=0.48, metal=0.25,
                   emission=hex_rgb(0xff8c3a), strength=0.35)
    ember = kit.mat("g_ember", hex_rgb(0x3a2c22), rough=0.55, metal=0.05,
                    emission=hex_rgb(0xff8c3a), strength=1.0)
    cloth = kit.mat("g_cloth", hex_rgb(0x241f1c), rough=1.0, double=True)

    body = kit.empty("g_body", None)
    bag = Bag(kit, body, "g_leg")
    for sx in (0.34, -0.34):
        bag.cyl(dark, 0.20, 0.15, 0.52, (sx, 0.98, 0.02), seg=8)
        bag.sph(stone, 0.16, (sx, 0.68, 0.05), (1.15, 0.7, 1.05))
        bag.box(steel, 0.30, 0.08, 0.26, (sx, 0.74, 0.12))
        bag.cyl(dark, 0.15, 0.11, 0.40, (sx, 0.42, 0.06), seg=8)
        bag.box(dark, 0.22, 0.28, 0.16, (sx, 0.28, 0.10))  # 胫甲
        bag.box(stone, 0.34, 0.14, 0.58, (sx, 0.10, 0.16))
        bag.box(steel, 0.30, 0.06, 0.22, (sx, 0.16, 0.40))  # 鞋头铁包
        bag.cyl(dark, 0.06, 0.02, 0.16, (sx, 0.10, 0.48), rot=(math.pi / 2, 0, 0), seg=5)
    # 腰下破布，不进披风摇摆（古达没有裙摆通道）
    v, f = _grid(4, 5, lambda u, v_: (
        -0.42 + u * 0.84,
        1.05 - v_ * 0.55,
        0.22 + math.sin(u * math.pi) * 0.08 + v_ * 0.12,
    ))
    bag.put(cloth, v, f)
    bag.flush()

    # 石像前倾。运行时 applyPose 会按当前姿态覆盖这些转角。
    torso = kit.empty("g_torso", body, (0, 1.35, 0), (0.55, 0, 0))
    tb = Bag(kit, torso, "g_torso")
    # 胸甲是上宽下收的旋转体，不是一颗球。肩留在两块甲上。
    v, f = _lathe([(-0.22, 0.30), (0.02, 0.46), (0.32, 0.62), (0.62, 0.50), (0.88, 0.26)], seg=12)
    tb.put(stone, v, f, (0, 0.08, 0.02), scale=(1.18, 1, 0.82))
    v, f = _lathe([(-0.16, 0.22), (0.10, 0.34), (0.40, 0.28)], seg=10)
    tb.put(dark, v, f, (0, -0.02, -0.02), scale=(1.05, 1, 0.8))
    tb.box(steel, 0.08, 0.55, 0.06, (0, 0.48, 0.48))  # 胸脊
    tb.box(dark, 0.46, 0.10, 0.10, (0, 0.28, 0.42))
    for s in (-1, 1):
        tb.box(dark, 0.22, 0.28, 0.05, (s * 0.22, -0.18, 0.22), (0.4, s * 0.15, 0))
        tb.box(stone, 0.16, 0.22, 0.04, (s * 0.38, -0.22, 0.16), (0.55, s * 0.4, 0))
    tb.cyl(dark, 0.16, 0.13, 0.22, (0, 0.98, 0.02), seg=8)
    # 肩甲：持戟一侧更大，侧面能分开
    tb.sph(stone, 0.34, (-0.78, 1.02, 0.02), (1.25, 0.42, 0.95))
    tb.sph(stone, 0.40, (0.88, 0.98, 0.04), (1.35, 0.40, 1.05))
    tb.cyl(steel, 0.08, 0.0, 0.28, (0.98, 1.22, 0.02), rot=(0, 0, -0.4), seg=5)
    tb.cyl(steel, 0.06, 0.0, 0.22, (-0.92, 1.18, 0.0), rot=(0, 0, 0.5), seg=5)
    tb.box(dark, 0.50, 0.06, 0.36, (0.86, 1.22, 0.02))
    tb.flush()

    head = kit.empty("g_head", torso, (0, 1.26, 0.05))
    hb = Bag(kit, head, "g_head")
    v, f = _lathe([(-0.32, 0.14), (-0.08, 0.24), (0.12, 0.23), (0.32, 0.14), (0.46, 0.03)], seg=10)
    hb.put(stone, v, f, scale=(1.05, 1, 1.08))
    hb.cyl(dark, 0.22, 0.24, 0.08, (0, -0.02, 0.02), seg=8)  # 盔沿
    hb.box(dark, 0.34, 0.07, 0.06, (0, -0.02, 0.24))  # 眼缝槽
    hb.sph(stone, 0.16, (0, -0.22, 0.04), (1.2, 0.7, 1.0))  # 下颊
    hb.box(dark, 0.10, 0.28, 0.16, (0, 0.36, -0.02))  # 盔脊
    # 断掉的环冠，只剩脑后到顶的一段
    crest = []
    for i in range(7):
        t = i / 6
        ang = math.radians(70 + t * 110)
        crest.append((0, 0.05 + math.sin(ang) * 0.42, -0.02 + math.cos(ang) * 0.10))
    hb.tube(steel, crest, [0.035, 0.04, 0.045, 0.04, 0.032, 0.02, 0.012], seg=5)
    hb.flush()
    for sx in (-0.07, 0.07):
        v, f = _box(0.07, 0.028, 0.02)
        kit.mesh(f"g_eye{sx:+.2f}", head, ember, v, f, (sx, -0.02, 0.26))

    # 胸口螺旋剑。位移在空物体上，朝向由运行时写（与旧 coil.rotation 相同）。
    coil = kit.empty("g_coil", torso, (0.2, 0.50, 0.52), (-0.22, 0.12, 0.4))
    cb = Bag(kit, coil, "g_coil")
    for i in range(6):
        k = i / 5
        ang = -0.7 + k * math.pi * 1.9
        cb.box(ember, 0.42, 0.14, 0.045,
               (math.cos(ang) * 0.18, -0.42 + k * 0.86, math.sin(ang) * 0.18),
               (0, ang + math.pi / 2, 0.4))
    cb.box(ember, 0.50, 0.045, 0.10, (0, 0.50, 0))
    cb.sph(ember, 0.06, (0, 0.50, 0), (1.6, 0.4, 0.8))
    cb.flush()

    def arm(name, sx, rot):
        g = kit.empty(name, torso, (sx * 0.85, 0.95, 0), rot)
        ab = Bag(kit, g, name)
        ab.cyl(stone, 0.17, 0.13, 0.40, (0, -0.22, 0), seg=8)
        ab.sph(dark, 0.11, (0, -0.42, 0), (1.1, 0.7, 1.1))
        ab.cyl(stone, 0.13, 0.10, 0.36, (0, -0.60, 0), seg=8)
        ab.box(steel, 0.26, 0.18, 0.24, (0, -0.86, 0.03))
        ab.box(dark, 0.08, 0.08, 0.10, (sx * 0.08, -0.90, 0.14))
        ab.flush()
        return g

    arm_r = arm("g_armR", 1, (0.05, 0, 0))
    arm("g_armL", -1, (0, 0.2, 0))

    hal = kit.empty("g_hal", arm_r, (0, -0.8, 0.3), (math.pi / 2 - 0.5, 0, 0))
    hb = Bag(kit, hal, "g_hal")
    hb.cyl(dark, 0.09, 0.075, 3.15, (0, 0.05, 0), seg=8)
    for y in (-0.4, 0.15, 0.7):
        v, f = _torus_y(0.11, 0.02, seg=8, tseg=5)
        hb.put(steel, v, f, (0, y, 0))
    # 斧刃：月牙，厚脊朝杆，刃口朝 +X
    outer, inner = [], []
    for i in range(9):
        t = i / 8
        ang = math.radians(-30 + t * 150)
        outer.append((0.05 + math.cos(ang) * 0.62, 1.05 + math.sin(ang) * 0.48, 0))
        inner.append((0.05 + math.cos(ang) * 0.22, 1.05 + math.sin(ang) * 0.16, 0))
    verts = []
    for p in outer + inner:
        verts.append((p[0], p[1], 0.07))
        verts.append((p[0], p[1], -0.07))
    faces = []
    def vi(which, i, zsign):
        return (which * 9 + i) * 2 + (0 if zsign > 0 else 1)
    for i in range(8):
        faces.append((vi(0, i, 1), vi(0, i + 1, 1), vi(1, i + 1, 1), vi(1, i, 1)))
        faces.append((vi(0, i + 1, -1), vi(0, i, -1), vi(1, i, -1), vi(1, i + 1, -1)))
        faces.append((vi(0, i, 1), vi(0, i, -1), vi(0, i + 1, -1), vi(0, i + 1, 1)))
    hb.put(steel, verts, faces)
    v, f = _blade(1.15, 1.55, 0.55, 0.05)
    # 刃口一条余烬，贴在月牙外沿的高度上，薄
    hb.box(edge, 0.90, 0.06, 0.025, (0.42, 1.28, 0.08), (0, 0, 0.5))
    hb.box(edge, 0.70, 0.05, 0.025, (0.28, 0.82, 0.08), (0, 0, -0.3))
    hb.cyl(steel, 0.10, 0.0, 0.85, (0, 1.95, 0), seg=6)  # 枪尖，末端约 y=2.38
    hb.cyl(steel, 0.06, 0.0, 0.36, (-0.22, 1.15, 0), rot=(0, 0, math.pi / 2), seg=5)
    hb.box(steel, 0.22, 0.36, 0.22, (0, 1.02, 0))
    hb.flush()

    # 人性的沉淀。运行时按节重摆、沿 Z 拉长，所以每节单独一个网格，长度沿 Z。
    radii = [0.26, 0.38, 0.48, 0.42, 0.28, 0.18, 0.14, 0.12]
    depth = [0.34, 0.36, 0.36, 0.34, 0.32, 0.30, 0.28]
    wide = [1.15, 1.40, 1.25, 1.05, 0.90, 0.75, 0.70]
    tall = [1.05, 1.35, 1.20, 0.95, 0.75, 0.62, 0.58]
    for i, ln in enumerate(depth):
        r0, r1 = radii[i], radii[i + 1]
        # 先把圆柱放倒到 Z（吻向 +Z），再在横截面上压扁。顺序不能反，否则会把身长一起压扁。
        v, f = _cyl_y(r0, r1, ln, seg=8)
        baked = three_matrix(scale=(wide[i], tall[i], 1)) @ three_matrix(rot=(math.pi / 2, 0, 0))
        v = [tuple((baked @ Vector((x, y, z, 1))).xyz) for x, y, z in v]
        seg = kit.mesh(f"g_serp{i}", torso, stone, v, f)
        if 1 <= i <= 2:
            ev, ef = _box(r0 * wide[i] * 0.5, r0 * tall[i] * 0.12, ln * 0.45)
            kit.mesh(f"g_serp{i}_ember", seg, ember, ev, ef, (0, -r0 * tall[i] * 0.85, 0))
    # 头。不拉长。吻在 +Z。
    hv, hf = _sphere(0.22, 10, 7)
    head_m = kit.mesh("g_serp7", torso, stone, hv, hf, scale=(1.45, 0.85, 1.15))
    jv, jf = _box(0.28, 0.10, 0.22)
    # 下颚、吻部焊进同一个网格，避免运行时只摆父级时丢件——它们得是子网格
    kit.mesh("g_serp7_jaw", head_m, dark, jv, jf, (0, -0.16, 0.10))
    sv, sf = _cyl_y(0.10, 0.02, 0.36, seg=6)
    kit.mesh("g_serp7_snout", head_m, dark, sv, sf, (0, -0.02, 0.28), rot=(math.pi / 2, 0, 0))
    for sx in (-1, 1):
        ev, ef = _box(0.08, 0.05, 0.04)
        kit.mesh(f"g_serp7_eye{sx}", head_m, ember, ev, ef, (sx * 0.16, 0.04, 0.16))
    mv, mf = _box(0.16, 0.04, 0.12)
    kit.mesh("g_serp7_maw", head_m, ember, mv, mf, (0, -0.08, 0.16))
    return body


# ---------------------------------------------------------------- 玻尔多（已经是世界米，含 BULK）

def build_vordt(kit):
    bulk = 3.8 / 2.579
    def sc(n):
        return n * bulk

    plate = kit.mat("v_plate", hex_rgb(0x3d4046), rough=0.8, metal=0.2)
    dark = kit.mat("v_dark", hex_rgb(0x23262b), rough=0.92, metal=0.1)
    steel = kit.mat("v_steel", hex_rgb(0x4c5560), rough=0.55, metal=0.4)
    trim = kit.mat("v_trim", hex_rgb(0x5a636e), rough=0.45, metal=0.48)
    ice = kit.mat("v_ice", hex_rgb(0x9fd8e8), rough=0.22, metal=0.05,
                  emission=hex_rgb(0x5fb9d6), strength=0.55)
    eye = kit.mat("v_eye", hex_rgb(0x0c1014), rough=0.4,
                  emission=hex_rgb(0x9fd8e8), strength=1.0)
    haft = kit.mat("v_haft", hex_rgb(0x2e2a24), rough=0.9, metal=0.02)

    body = kit.empty("v_body", None)
    hind = 0.88
    for name, sx in (("v_legR", 1), ("v_legL", -1)):
        g = kit.empty(name, body, (sc(sx * 0.5), sc(1.32 * hind), sc(-0.55)), (-0.37, 0, 0))
        b = Bag(kit, g, name)
        b.cyl(dark, sc(0.20), sc(0.15), sc(0.78 * hind), (0, sc(-0.32 * hind), sc(0.08)), seg=8)
        b.sph(plate, sc(0.16), (0, sc(-0.70 * hind), sc(0.02)), (1.2, 0.7, 1.1))
        b.cyl(dark, sc(0.16), sc(0.12), sc(0.62 * hind), (0, sc(-0.95 * hind), sc(-0.08)), rot=(0.35, 0, 0), seg=7)
        b.box(plate, sc(0.36), sc(0.16), sc(0.55), (0, sc(-1.22 * hind), sc(0.08)))
        b.box(steel, sc(0.16), sc(0.08), sc(0.10), (sx * sc(0.10), sc(-1.16 * hind), sc(0.28)))
        b.flush()
    tb = Bag(kit, body, "v_tail")
    tb.cyl(dark, sc(0.10), sc(0.03), sc(0.7), (0, sc(0.78), sc(-1.15)), rot=(1.1, 0, 0), seg=6)
    tb.flush()

    torso = kit.empty("v_torso", body, (0, sc(1.2), sc(-0.1)), (0.9, 0, 0))
    cb = Bag(kit, torso, "v_chest")
    cb.sph(dark, sc(0.55), (0, sc(-0.05), sc(-0.35)), (1.05, 0.7, 1.15))  # 腰
    cb.sph(plate, sc(0.78), (0, sc(0.28), sc(0.25)), (1.15, 0.85, 1.35))  # 胸
    cb.box(steel, sc(1.15), sc(0.16), sc(0.9), (0, sc(0.72), sc(0.15)))
    for s in (-1, 1):
        cb.sph(steel, sc(0.38), (s * sc(0.95), sc(1.05), sc(0.2)), (0.85, 0.7, 1.05))
        cb.cyl(trim, sc(0.12), 0.0, sc(0.36), (s * sc(0.95), sc(0.85), sc(0.62)), rot=(math.pi / 2, 0, 0), seg=5)
        cb.cyl(ice, sc(0.07), 0.0, sc(0.32), (s * sc(0.95), sc(1.42), sc(0.18)), rot=(-0.4, 0, 0), seg=5)
    # 脊上冰晶，后掠
    for i, (z, base, h) in enumerate(((-0.02, 0.78, 0.58), (-0.26, 0.62, 0.74), (-0.48, 0.46, 0.56), (-0.68, 0.34, 0.4))):
        cb.cyl(ice, sc(h * 0.2), 0.0, sc(h), (sc(0.08 if i % 2 else -0.08), sc(base + h * 0.3), sc(z)), rot=(-0.7, 0, 0), seg=5)
    # 颈
    cb.tube(dark, [
        (0, sc(0.70), sc(0.30)),
        (0, sc(1.20), sc(0.38)),
        (0, sc(1.70), sc(0.42)),
    ], [sc(0.34), sc(0.26), sc(0.20)], seg=7)
    cb.flush()

    head = kit.empty("v_headG", torso, (0, sc(2.02), sc(0.46)), (0.35, 0, 0))
    hb = Bag(kit, head, "v_head")
    hb.sph(plate, sc(0.32), (0, 0, 0), (1.05, 0.9, 1.05))
    hb.cyl(dark, sc(0.16), sc(0.10), sc(0.55), (0, sc(-0.04), sc(0.42)), rot=(math.pi / 2, 0, 0), seg=7)
    hb.box(dark, sc(0.20), sc(0.12), sc(0.16), (0, sc(-0.02), sc(0.70)))
    hb.cyl(plate, sc(0.12), sc(0.04), sc(0.36), (0, sc(-0.20), sc(0.40)), rot=(1.15, 0, 0), seg=6)
    hb.box(steel, sc(0.36), sc(0.08), sc(0.16), (0, sc(0.16), sc(0.22)), (0.3, 0, 0))
    # 两只角不对称：一只前扬，一只后钩
    hb.tube(trim, [
        (sc(0.10), sc(0.22), sc(0.02)),
        (sc(0.22), sc(0.55), sc(0.16)),
        (sc(0.16), sc(0.92), sc(0.05)),
        (sc(0.06), sc(1.10), sc(-0.08)),
    ], [sc(0.09), sc(0.07), sc(0.045), sc(0.02)], seg=5)
    hb.tube(trim, [
        (sc(-0.08), sc(0.20), sc(-0.02)),
        (sc(-0.20), sc(0.48), sc(-0.16)),
        (sc(-0.10), sc(0.62), sc(-0.42)),
        (sc(-0.02), sc(0.50), sc(-0.62)),
    ], [sc(0.08), sc(0.06), sc(0.04), sc(0.015)], seg=5)
    hb.flush()
    ev, ef = _box(sc(0.07), sc(0.045), sc(0.03))
    eye_verts = ev + [(x + sc(0.22), y, z) for x, y, z in ev]
    eye_faces = ef + [tuple(i + 8 for i in face) for face in ef]
    kit.mesh("v_eye", head, eye, eye_verts, eye_faces, (sc(-0.11), sc(0.04), sc(0.32)))

    plant = 0.28
    def fore(name, sx, hammer, rot):
        g = kit.empty(name, torso, (sc(sx * 0.98), sc(0.42), sc(0.5)), rot)
        b = Bag(kit, g, name)
        b.cyl(plate, sc(0.28), sc(0.20), sc(0.72), (0, sc(-0.32 + plant), sc(0.04)), seg=8)
        b.cyl(dark, sc(0.22), sc(0.16), sc(0.6), (0, sc(-0.85 + plant), sc(0.12)), rot=(0.28, 0, 0), seg=7)
        b.box(steel if hammer else dark, sc(0.62), sc(0.28), sc(0.55), (0, sc(-1.28 + plant), sc(0.28)))
        b.flush()
        return g

    arm_r = fore("v_armR", 1, True, (-0.7, 0, 0))
    fore("v_armL", -1, False, (-0.3, 0.12, 0))
    hammer = kit.empty("v_hammer", arm_r, (0, sc(-1.42 + plant), sc(0.38)), (1.6, 0, 0))
    mb = Bag(kit, hammer, "v_ham")
    # 杆从握点伸到锤头。锤头中心钉在命中锚点 (0, sc(0.364), sc(1.537))
    mb.cyl(haft, sc(0.09), sc(0.07), sc(1.55), (0, sc(0.22), sc(0.85)), rot=(math.pi / 2 - 0.15, 0, 0), seg=7)
    hx, hy, hz = 0, sc(0.364), sc(1.537)
    mb.box(trim, sc(0.96), sc(0.72), sc(0.66), (hx, hy, hz))
    mb.box(steel, sc(1.12), sc(0.16), sc(0.78), (hx, hy, hz))
    mb.box(steel, sc(0.36), sc(0.30), sc(0.30), (0, sc(0.22), sc(1.15)))
    for s in (-1, 1):
        mb.cyl(steel, sc(0.08), 0.0, sc(0.22), (s * sc(0.52), hy + sc(0.1), hz), rot=(0, 0, math.pi / 2), seg=5)
    mb.flush()
    # 二阶段才显的冰，运行时把 visible 打开
    for i, (ix, iy, iz, r) in enumerate((
        (sc(0.28), hy + sc(0.48), hz - sc(0.1), sc(0.16)),
        (0, hy + sc(0.55), hz + sc(0.06), sc(0.20)),
        (sc(-0.26), hy + sc(0.46), hz + sc(0.22), sc(0.14)),
    )):
        v, f = _sphere(r, 6, 5)
        kit.mesh(f"v_ice{i}", hammer, ice, v, f, (ix, iy, iz), scale=(1, 1.4, 0.8))
    return body


# ---------------------------------------------------------------- 深渊监视者

def build_watchers(kit):
    s = 2.15 / 2.57
    def u(n):
        return n * s

    iron = kit.mat("w_iron", hex_rgb(0x2a2e34), rough=0.7, metal=0.35)
    dark = kit.mat("w_dark", hex_rgb(0x14161a), rough=0.92, metal=0.15)
    cloth = kit.mat("w_cloth", hex_rgb(0x121014), rough=1.0, double=True)
    blade = kit.mat("w_blade", hex_rgb(0x9aa4ae), rough=0.32, metal=0.72,
                    emission=hex_rgb(0xff5a20), strength=1.0)
    eye = kit.mat("w_eye", hex_rgb(0x1a0505), rough=0.5,
                  emission=hex_rgb(0xff3b30), strength=1.0)

    body = kit.empty("w_body", None)
    for name, shin_name, sx in (("w_legR", "w_shinR", 0.085), ("w_legL", "w_shinL", -0.085)):
        leg = kit.empty(name, body, (sx, 1.2, 0))
        b = Bag(kit, leg, name)
        b.cyl(dark, 0.055, 0.045, 0.58, (0, -0.30, 0), seg=6)
        b.box(iron, 0.07, 0.10, 0.08, (0, -0.58, 0.02))
        b.flush()
        shin = kit.empty(shin_name, leg, (0, -0.64, 0))
        sb = Bag(kit, shin, shin_name)
        sb.cyl(dark, 0.042, 0.034, 0.46, (0, -0.22, 0.01), seg=6)
        sb.box(iron, 0.07, 0.32, 0.05, (0, -0.20, 0.045))
        sb.box(dark, 0.10, 0.06, 0.24, (0, -0.50, 0.06))
        sb.flush()
    pb = Bag(kit, body, "w_hip")
    pb.sph(iron, 0.09, (0, 1.18, 0), (1.3, 0.7, 1.0))
    pb.box(dark, 0.20, 0.04, 0.12, (0, 1.12, 0.02))
    for fx, ry in ((0.0, 0.0), (0.08, 0.5), (-0.08, -0.5)):
        pb.box(iron, 0.08, 0.16, 0.02, (fx, 1.02, 0.08), (0.45, ry, 0))
    pb.flush()

    torso = kit.empty("w_torso", body, (0, u(1.45), 0), (0.1, 0, 0))
    tb = Bag(kit, torso, "w_torso")
    tb.cyl(dark, u(0.09), u(0.07), u(0.32), (0, u(0.06), 0), seg=7)
    tb.sph(iron, u(0.16), (0, u(0.38), u(0.02)), (0.85, 1.15, 0.62))
    tb.box(iron, u(0.22), u(0.28), u(0.08), (0, u(0.48), u(0.08)))
    tb.box(dark, u(0.16), u(0.36), u(0.03), (0, u(0.40), u(-0.10)))
    tb.cyl(dark, u(0.045), u(0.04), u(0.16), (0, u(0.72), 0), seg=6)
    for s in (-1, 1):
        tb.box(iron, 0.12, 0.045, 0.12, (s * 0.16, u(0.62), 0), (0, 0, -s * 0.4))
    tb.sph(dark, 0.035, (0, u(0.42), u(0.12)))
    tb.flush()

    head = kit.empty("w_head", torso, (0, u(0.88), u(0.03)), (0.5, 0, 0))
    hb = Bag(kit, head, "w_head")
    hb.sph(iron, u(0.13), (0, u(0.02), 0), (0.95, 1.15, 1.05))
    hb.box(dark, u(0.20), u(0.05), u(0.04), (0, u(0.02), u(0.12)))
    # 兜帽：额前开口，顶往后收成尖，布尾贴背
    hb.tube(cloth, [
        (-u(0.12), u(0.08), u(0.08)),
        (0, u(0.10), u(0.10)),
        (u(0.12), u(0.08), u(0.08)),
    ], [u(0.02), u(0.02), u(0.02)], seg=4)
    hood = [
        (0, u(0.16), u(0.06)),
        (0, u(0.30), u(-0.02)),
        (0, u(0.38), u(-0.10)),
        (0, u(0.22), u(-0.18)),
        (0, u(0.02), u(-0.20)),
        (0, u(-0.22), u(-0.16)),
    ]
    hb.tube(cloth, hood, [u(0.12), u(0.11), u(0.05), u(0.10), u(0.09), u(0.04)], seg=6)
    hb.flush()
    ev, ef = _box(u(0.14), u(0.028), u(0.015))
    kit.mesh("w_eye", head, eye, ev, ef, (0, u(0.02), u(0.145)))

    arm_r = kit.empty("w_armR", torso, (0.155, u(0.66), 0), (-0.15, 0, 0.64))
    ab = Bag(kit, arm_r, "w_armR")
    ab.cyl(dark, u(0.045), u(0.038), u(0.40), (0, u(-0.22), 0), seg=6)
    ab.cyl(iron, u(0.04), u(0.032), u(0.36), (0, u(-0.56), u(0.02)), seg=6)
    ab.box(iron, u(0.09), u(0.08), u(0.08), (0, u(-0.78), u(0.04)))
    ab.flush()
    sword = kit.empty("w_sword", arm_r, (0, u(-0.94), u(0.06)), (0.3, 0, 0))
    sb = Bag(kit, sword, "w_sword")
    sb.cyl(dark, u(0.022), u(0.02), u(0.42), (0, u(-0.02), 0), seg=6)
    for gy in (0.08, -0.02, -0.12):
        v, f = _torus_y(u(0.028), u(0.008), seg=7, tseg=4)
        sb.put(iron, v, f, (0, u(gy), 0))
    sb.sph(dark, u(0.04), (0, u(0.22), 0), (1.1, 1.3, 1.1))
    sb.box(iron, u(0.36), u(0.045), u(0.07), (0, u(-0.32), 0))
    sb.box(iron, u(0.05), u(0.14), u(0.04), (u(-0.16), u(-0.38), 0), (0, 0, 0.7))
    sb.box(iron, u(0.05), u(0.14), u(0.04), (u(0.16), u(-0.38), 0), (0, 0, -0.7))
    bv, bf = _blade(u(-0.40), u(-1.85), u(0.07), u(0.018))
    sb.put(blade, bv, bf)
    sb.flush()

    arm_l = kit.empty("w_armL", torso, (-0.155, u(0.66), 0), (-0.05, 0.18, 0))
    lb = Bag(kit, arm_l, "w_armL")
    lb.cyl(dark, u(0.042), u(0.034), u(0.38), (0, u(-0.20), 0), seg=6)
    lb.cyl(iron, u(0.036), u(0.03), u(0.34), (0, u(-0.52), u(0.02)), seg=6)
    lb.box(iron, u(0.08), u(0.07), u(0.07), (0, u(-0.74), u(0.03)))
    lb.flush()
    dagger = kit.empty("w_dagger", arm_l, (0, u(-0.88), u(0.04)), (0.35, 0, 0))
    db = Bag(kit, dagger, "w_dag")
    db.cyl(dark, u(0.016), u(0.014), u(0.16), (0, u(0.02), 0), seg=5)
    db.box(iron, u(0.16), u(0.028), u(0.04), (0, u(-0.08), 0))
    dv, df = _blade(u(-0.12), u(-0.61), u(0.035), u(0.012), stations=5)
    db.put(blade, dv, df)
    db.flush()

    # 斗篷。枢轴在肩胛，运行时改 rotation 摆动。下摆撕开。
    def rag(name, x0, x1, length, z):
        v, f = _grid(3, 6, lambda uu, vv: (
            x0 + (x1 - x0) * uu + math.sin(vv * math.pi) * 0.01,
            -vv * length,
            -0.02 - vv * 0.08 - math.sin(uu * math.pi) * 0.04,
        ))
        # 撕掉右下两格：丢掉最后一行靠一侧的面
        f = [face for face in f if not (face[0] >= 5 * 4 and (face[0] % 4) == 0)]
        kit.mesh(name, torso, cloth, v, f, (0, u(0.55), z), pivot=True)

    # 主斗篷更宽，另两片是肩后的破布
    v, f = _grid(5, 8, lambda uu, vv: (
        u(-0.22) + (u(0.16) - u(-0.22)) * uu,
        u(0.15) - vv * u(1.55) + (0.12 if uu < 0.25 else 0) * vv * vv,
        u(-0.12) - vv * u(0.35),
    ))
    # 左下角撕开
    f = [face for face in f if not (face[2] > 40 and face[0] % 6 == 0)]
    kit.mesh("w_cape0", torso, cloth, v, f, (0, u(0.35), u(-0.12)), pivot=True)
    rag("w_cape1", u(-0.16), u(-0.02), u(0.42), u(-0.16))
    rag("w_cape2", u(0.0), u(0.10), u(0.30), u(-0.14))
    return body


# ---------------------------------------------------------------- 沙力万

def build_sulyvahn(kit):
    cloth = kit.mat("s_cloth", hex_rgb(0x211c2a), rough=0.95, metal=0.04, double=True)
    dark = kit.mat("s_dark", hex_rgb(0x16131e), rough=1.0, double=True)
    steel = kit.mat("s_steel", hex_rgb(0x494f5c), rough=0.5, metal=0.45)
    gold = kit.mat("s_gold", hex_rgb(0xe6c37a), rough=0.4, metal=0.65,
                   emission=hex_rgb(0x241a08), strength=0.15)
    fire = kit.mat("s_fire", hex_rgb(0xff5a20), rough=0.4, metal=0.2,
                   emission=hex_rgb(0xff5a20), strength=1.0)
    darkflame = kit.mat("s_darkflame", hex_rgb(0x7a4d9e), rough=0.45, metal=0.2,
                        emission=hex_rgb(0x7a4d9e), strength=1.0)
    eye = kit.mat("s_eye", hex_rgb(0x0a0710), rough=0.45,
                  emission=hex_rgb(0x9a86d8), strength=1.0)

    body = kit.empty("sulBody", None)
    for leg_name, shin_name, sx in (("sulLegR", "sulShinR", 0.09), ("sulLegL", "sulShinL", -0.09)):
        leg = kit.empty(leg_name, body, (sx, 1.58, 0.02))
        b = Bag(kit, leg, leg_name)
        b.cyl(dark, 0.055, 0.042, 0.82, (0, -0.42, 0), seg=6)
        b.flush()
        shin = kit.empty(shin_name, leg, (0, -0.86, 0))
        sb = Bag(kit, shin, shin_name)
        sb.cyl(dark, 0.040, 0.030, 0.64, (0, -0.32, 0.01), seg=6)
        sb.box(dark, 0.07, 0.04, 0.22, (0, -0.68, 0.06))
        sb.flush()
    slit = 0.95
    v, f = _skirt(0.16, 0.28, 1.42, 10, slit * 0.65, math.pi * 2 - slit * 1.3)
    kit.mesh("sulSkirt0", body, dark, v, f, (0, 1.60, 0), pivot=True)
    v, f = _skirt(0.175, 0.42, 1.56, 12, slit * 0.5, math.pi * 2 - slit)
    kit.mesh("sulSkirt1", body, cloth, v, f, (0, 1.62, 0), pivot=True)
    bb = Bag(kit, body, "sulBelt")
    bb.box(steel, 0.34, 0.045, 0.20, (0, 1.64, 0.02))
    bb.sph(gold, 0.035, (0, 1.64, 0.12))
    bb.flush()

    torso = kit.empty("sulTorso", body, (0, 1.65, 0), (0.04, 0, 0))
    tb = Bag(kit, torso, "sulTorso")
    tb.cyl(cloth, 0.16, 0.13, 0.62, (0, 0.32, 0), seg=8)
    tb.box(dark, 0.18, 0.40, 0.03, (0, 0.34, -0.14))
    tb.box(gold, 0.10, 0.10, 0.02, (0, 0.40, 0.16), (0, 0, math.pi / 4))
    for s, (dx, dy) in ((1, (0.06, 0.52)), (-1, (-0.045, 0.48)), (1, (0.01, 0.44))):
        tb.sph(steel, 0.018 + (0.008 if dy > 0.5 else 0), (dx, dy, 0.15))
    for s in (-1, 1):
        tb.cyl(dark, 0.028, 0.024, 0.26, (s * 0.22, 0.62, 0), rot=(0, 0, math.pi / 2), seg=5)
        tb.box(steel, 0.10, 0.035, 0.11, (s * 0.40, 0.68, 0), (0, 0, -s * 0.35))
    tb.cyl(dark, 0.045, 0.040, 0.28, (0, 0.78, 0), seg=6)
    tb.flush()

    head = kit.empty("sulHead", torso, (0, 1.02, 0.02), (0.52, 0, 0))
    hb = Bag(kit, head, "sulHead")
    hb.cyl(dark, 0.09, 0.07, 0.26, (0, 0.02, 0), seg=6)
    hb.cyl(gold, 0.115, 0.11, 0.03, (0, 0.12, 0), seg=6)
    hb.cyl(cloth, 0.13, 0.0, 0.42, (0, 0.32, 0), seg=6)  # 冠，尖在头顶之上
    for s in (-1, 1):
        hb.box(dark, 0.025, 0.34, 0.06, (s * 0.14, 0.26, 0), (0, 0, -s * 0.5))
    hb.flush()
    ev, ef = _box(0.09, 0.02, 0.016)
    kit.mesh("sulEye", head, eye, ev, ef, (0, 0.02, 0.09))

    def sword(name, parent, side, blade_mat):
        g = kit.empty(name, parent, (0, -0.88, 0.04), (0.22, 0, side * 0.12))
        b = Bag(kit, g, name)
        b.cyl(dark, 0.022, 0.02, 0.24, (0, 0.04, 0), seg=6)
        b.sph(gold, 0.045, (0, 0.18, 0), (1.0, 1.15, 1.0))
        b.box(steel, 0.58, 0.05, 0.07, (0, -0.15, 0))
        b.box(gold, 0.08, 0.10, 0.08, (0.26, -0.15, 0))
        b.box(gold, 0.08, 0.10, 0.08, (-0.26, -0.15, 0))
        b.box(steel, 0.22, 0.035, 0.045, (0.16, -0.24, 0), (0, 0, 0.55))
        b.box(steel, 0.22, 0.035, 0.045, (-0.16, -0.24, 0), (0, 0, -0.55))
        bv, bf = _blade(-0.28, -2.74, 0.055, 0.016)
        b.put(blade_mat, bv, bf)
        b.flush()
        return g

    arm_r = kit.empty("sulArmR", torso, (0.44, 0.68, 0), (-1.2, -0.16, -0.1))
    rb = Bag(kit, arm_r, "sulArmR")
    rb.cyl(dark, 0.038, 0.030, 0.44, (0, -0.24, 0), seg=6)
    rb.cyl(cloth, 0.030, 0.026, 0.34, (0, -0.60, 0.01), seg=6)
    rb.cyl(steel, 0.036, 0.032, 0.09, (0, -0.80, 0.02), seg=6)
    rb.flush()
    sword("sulSwordR", arm_r, 1, fire)

    arm_l = kit.empty("sulArmL", torso, (-0.44, 0.68, 0), (-1.2, 0.16, 0.1))
    lb = Bag(kit, arm_l, "sulArmL")
    lb.cyl(dark, 0.038, 0.030, 0.44, (0, -0.24, 0), seg=6)
    lb.cyl(cloth, 0.030, 0.026, 0.34, (0, -0.60, 0.01), seg=6)
    lb.cyl(steel, 0.036, 0.032, 0.09, (0, -0.80, 0.02), seg=6)
    lb.flush()
    sword("sulSwordL", arm_l, -1, darkflame)
    return body


def main():
    _purge_objects(set())
    col = boss_collection()
    kit = Kit(col)
    roots = [
        (build_gundyr(kit), "boss-gundyr.glb", 0.0, 4.2 / 3.182),
        (build_vordt(kit), "boss-vordt.glb", 6.5, 1.0),
        (build_watchers(kit), "boss-watchers.glb", 11.5, 1.0),
        (build_sulyvahn(kit), "boss-sulyvahn.glb", 15.5, 1.0),
    ]
    bpy.context.view_layer.update()
    for root, filename, _x, _s in roots:
        export_tree(root, filename)
    # 导出之后才挪开，方便在视口里跟角色并排看。GLB 里根节点仍在原点。
    for root, _fn, x, s in roots:
        root.matrix_local = Matrix.Translation(Vector((x, 0, 0))) @ Matrix.Scale(s, 4)
    bpy.context.view_layer.update()
    print("INFERNO_BOSSES_OK")


if __name__ == "__main__":
    main()
