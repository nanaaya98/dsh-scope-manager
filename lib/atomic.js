// 原子写：同目录临时文件 → rename。
// rename 跨卷会 EXDEV，同目录不会；写坏了的半截文件由 rename 一次性换掉。
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 把一段文本原子地写到目标文件。
 * @param {string} file 目标路径
 * @param {string} text 内容
 */
export async function writeAtomic(file, text) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${file.split('/').pop()}.${randomUUID().slice(0, 8)}.tmp`);
    try {
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, file);
    }
    catch (e) {
        await rm(tmp, { force: true }).catch(() => { });
        throw e;
    }
}
