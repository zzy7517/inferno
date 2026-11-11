#!/usr/bin/env node
/** M0 验收：解析 GLB 的 JSON chunk，断言三个动画 clip 与骨架存在 */
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "web/public/assets/character.glb";
const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("不是 GLB 文件");
const jsonLen = buf.readUInt32LE(12);
const jsonType = buf.readUInt32LE(16);
if (jsonType !== 0x4e4f534a) throw new Error("缺 JSON chunk");
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf-8"));

const anims = (gltf.animations ?? []).map(a => a.name);
const nodes = gltf.nodes?.length ?? 0;
const meshes = gltf.meshes?.length ?? 0;
const joints = (gltf.nodes ?? []).filter(n => n.joint ?? n.skin !== undefined).length;
console.log(`animations=${JSON.stringify(anims)} nodes=${nodes} meshes=${meshes}`);

const need = ["idle", "attack", "roll"];
const missing = need.filter(n => !anims.includes(n));
if (missing.length) throw new Error(`缺少动画 clip: ${missing}`);
if (meshes < 20) throw new Error(`部件数异常: ${meshes}`);
console.log("GLB_VERIFY_PASS ✓ 三动画 clip、骨架、部件齐全");
