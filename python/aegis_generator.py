"""Aegis 授权文件生成器 v3.0 —— 离线授权,与 godot/addons/aegis 配套使用。"""
import base64
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta

from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from Crypto.Util.Padding import pad, unpad

VERSION = "3.1.0"

# 内置固定密钥 (单文件发布给别人使用时写在这里,改动密钥后重新打包 exe 即可)
DEFAULT_SHARED_SECRET = "MyStudio_Secret_2026"

# 管理员登录密码的 SHA256(默认密码 mzkj112233)。换密码: python aegis_generator.py --hash 新密码
ADMIN_PASSWORD_HASH = "b6c52ce517054a5c5f1f87b1d16db109c0cc5b9231407da8cc02b1d9dad22e2a"

PROJECT_REL = os.path.join("godot", "project.godot")
NAME_RE = re.compile(r'^config/name="(.*)"\s*$', re.M)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[0-9a-f]{10}$")

ASCII_TAG = re.compile(rb"AG-([0-9a-f]{10})-([0-9a-f]{8})")
UTF16_TAG = re.compile(rb"A\x00G\x00-\x00((?:[0-9a-f]\x00){10})-\x00((?:[0-9a-f]\x00){8})")
SCAN_CHUNK = 16 * 1024 * 1024


class AegisError(Exception):
    """可直接展示给用户的错误"""


def app_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


LOG_PATH = os.path.join(app_dir(), "issued_licenses.csv")


def _candidates(rel: str) -> list:
    base = app_dir()
    paths = [
        os.path.join(base, "..", rel),
        os.path.join(base, rel),
        os.path.join(os.getcwd(), "..", rel),
        os.path.join(os.getcwd(), rel),
    ]
    return [os.path.normpath(p) for p in paths]


def find_file(rel: str) -> str:
    for p in _candidates(rel):
        if os.path.isfile(p):
            return p
    return ""


def secret_fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:8]


def read_project_name(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            text = f.read()
    except OSError as e:
        raise AegisError(f"无法读取工程文件:\n{path}\n{e}")
    m = NAME_RE.search(text)
    if not m or not m.group(1):
        raise AegisError("在 project.godot 里没找到 config/name。")
    return m.group(1)


def project_code(project_name: str, secret: str) -> str:
    return hashlib.sha256((project_name + secret).encode("utf-8")).hexdigest()[:10]


def read_exe_tag(path: str) -> tuple:
    found, keep = set(), b""
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(SCAN_CHUNK)
                if not chunk:
                    break
                buf = keep + chunk
                for m in ASCII_TAG.finditer(buf):
                    found.add((m.group(1).decode(), m.group(2).decode()))
                for m in UTF16_TAG.finditer(buf):
                    found.add((m.group(1).decode("utf-16-le"), m.group(2).decode("utf-16-le")))
                keep = buf[-64:]
    except OSError as e:
        raise AegisError(f"无法读取文件:\n{path}\n{e}")
    if not found:
        raise AegisError("该文件里没有找到导出标记。\n请确认已在导出预设的\"商标\"字段粘贴 Dock 里的「导出标记」,并重新导出。")
    if len(found) > 1:
        raise AegisError("发现多个不同的导出标记,无法确定项目 ID,请检查导出预设。")
    return found.pop()


def derive_key(code: str, secret: str) -> bytes:
    return hashlib.sha256((code + secret).encode("utf-8")).digest()


def parse_date(text: str, label: str) -> date:
    text = text.strip()
    if not DATE_RE.match(text):
        raise AegisError(f"{label}格式错误,请使用 YYYY-MM-DD。")
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise AegisError(f"{label}不是有效日期。")


def build_license(code: str, secret: str, issue: date, expire: date, customer: str = "") -> tuple:
    if issue > expire:
        raise AegisError("签发日期不能晚于到期日期。")
    if issue.year < 2000 or expire.year > 9999:
        raise AegisError("日期范围应在 2000 ~ 9999 年之间。")
    data = {
        "v": 3,
        "issue": issue.isoformat(),
        "expire": expire.isoformat(),
        "project": code,
        "customer": customer,
        "license_id": str(uuid.uuid4()),
    }
    plain = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    iv = get_random_bytes(16)
    encrypted = AES.new(derive_key(code, secret), AES.MODE_CBC, iv).encrypt(pad(plain, AES.block_size))
    return base64.b64encode(iv + encrypted), data


def decrypt_license(encoded: bytes, code: str, secret: str) -> dict:
    raw = base64.b64decode(b"".join(encoded.split()))
    if len(raw) <= 16 or (len(raw) - 16) % 16:
        raise AegisError("授权文件长度异常。")
    plain = AES.new(derive_key(code, secret), AES.MODE_CBC, raw[:16]).decrypt(raw[16:])
    return json.loads(unpad(plain, AES.block_size).decode("utf-8"))


def write_license(directory: str, filename: str, code: str, secret: str, issue: date, expire: date, customer: str) -> str:
    filename = os.path.basename(filename.strip()) or "license.dat"
    encoded, data = build_license(code, secret, issue, expire, customer)
    path = os.path.abspath(os.path.join(directory, filename))
    try:
        with open(path, "wb") as f:
            f.write(encoded)
        with open(path, "rb") as f:
            back = decrypt_license(f.read(), code, secret)
    except OSError as e:
        raise AegisError(f"写入授权文件失败:\n{e}")
    except Exception:
        raise AegisError("生成后自检失败(回读解密不一致),请重试。")
    if back != data:
        raise AegisError("生成后自检失败(内容不一致),请重试。")
    append_log(data)
    return path


def append_log(data: dict) -> None:
    try:
        new_file = not os.path.exists(LOG_PATH)
        with open(LOG_PATH, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            if new_file:
                w.writerow(["logged_at", "license_id", "customer", "project", "issue", "expire"])
            w.writerow([datetime.now().isoformat(timespec="seconds"), data["license_id"], data["customer"],
                        data["project"], data["issue"], data["expire"]])
    except OSError:
        pass


def reveal_in_explorer(path: str) -> None:
    if os.name != "nt":
        return
    try:
        subprocess.Popen(["explorer", f"/select,{os.path.normpath(path)}"])
    except Exception:
        pass


class App:
    def __init__(self):
        import tkinter as tk
        from tkinter import filedialog, messagebox
        self.tk, self.fd, self.mb = tk, filedialog, messagebox
        self.root = tk.Tk()
        self.root.title(f"Aegis 授权生成器 v{VERSION}")
        self.root.resizable(False, False)
        self.frame = None
        self.show_login()

    def _center(self, w: int, h: int) -> None:
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() - w) // 2
        y = (self.root.winfo_screenheight() - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _new_frame(self):
        if self.frame is not None:
            self.frame.destroy()
        self.frame = self.tk.Frame(self.root)
        self.frame.pack(fill="both", expand=True)
        return self.frame

    @staticmethod
    def _set(entry, value: str) -> None:
        entry.delete(0, "end")
        entry.insert(0, value)

    def show_login(self) -> None:
        tk = self.tk
        f = self._new_frame()
        self._center(400, 190)
        tk.Label(f, text="请输入管理员密码:").pack(pady=(24, 6))
        self.pwd = tk.Entry(f, show="*", width=26)
        self.pwd.pack()
        self.pwd.focus_set()
        self.pwd.bind("<Return>", self.check_password)
        tk.Button(f, text="确认登录", command=self.check_password, bg="#2196F3", fg="white", width=15).pack(pady=20)

    def check_password(self, _event=None) -> None:
        digest = hashlib.sha256(self.pwd.get().encode("utf-8")).hexdigest()
        if digest != ADMIN_PASSWORD_HASH:
            self.mb.showerror("错误", "密码错误,无法进入系统!")
            return
        self.show_main()

    def show_main(self) -> None:
        tk = self.tk
        f = self._new_frame()
        self._center(640, 470)
        f.columnconfigure(1, weight=1)

        def row(r, text):
            tk.Label(f, text=text, anchor="e").grid(row=r, column=0, sticky="e", padx=(14, 6), pady=6)

        row(0, "共享密钥")
        self.secret_entry = tk.Entry(f)
        self.secret_entry.grid(row=0, column=1, sticky="we", padx=(0, 6))
        self._set(self.secret_entry, DEFAULT_SHARED_SECRET)

        secret_btns = tk.Frame(f)
        secret_btns.grid(row=0, column=2, padx=(0, 10))
        tk.Button(secret_btns, text="重置默认密钥", command=self.reset_default_secret).pack(side="left")

        self.secret_fp_lbl = tk.Label(f, fg="#888888", anchor="w")
        self.secret_fp_lbl.grid(row=1, column=1, columnspan=2, sticky="w")

        row(2, "项目 ID")
        self.project_entry = tk.Entry(f)
        self.project_entry.grid(row=2, column=1, sticky="we")
        btns = tk.Frame(f)
        btns.grid(row=2, column=2, padx=10)
        tk.Button(btns, text="从导出的 exe 读取", command=self.load_exe).pack(side="left")
        tk.Button(btns, text="从工程读取", command=self.load_project).pack(side="left", padx=(6, 0))

        self.project_lbl = tk.Label(f, fg="#888888", anchor="w", justify="left", wraplength=420)
        self.project_lbl.grid(row=3, column=1, columnspan=2, sticky="w")

        row(4, "客户 / 备注")
        self.customer_entry = tk.Entry(f)
        self.customer_entry.grid(row=4, column=1, columnspan=2, sticky="we", padx=(0, 10))

        row(5, "签发日期")
        self.issue_entry = tk.Entry(f)
        self.issue_entry.grid(row=5, column=1, columnspan=2, sticky="we", padx=(0, 10))
        self._set(self.issue_entry, date.today().isoformat())

        row(6, "授权天数")
        self.days_entry = tk.Entry(f)
        self.days_entry.grid(row=6, column=1, columnspan=2, sticky="we", padx=(0, 10))

        row(7, "到期日期")
        self.expire_entry = tk.Entry(f)
        self.expire_entry.grid(row=7, column=1, columnspan=2, sticky="we", padx=(0, 10))

        row(8, "文件名")
        self.filename_entry = tk.Entry(f)
        self.filename_entry.grid(row=8, column=1, columnspan=2, sticky="we", padx=(0, 10))
        self._set(self.filename_entry, "license.dat")

        tk.Button(f, text="生成授权文件", command=self.on_generate, bg="#4CAF50", fg="white", width=28).grid(
            row=9, column=0, columnspan=3, pady=(18, 8))
        tk.Label(f, justify="left", fg="#888888", text=(
            "· 到期日期含当天: 到期日 24:00 前有效,次日起失效 (按客户机器本地日期)\n"
            "· 密钥已固化在程序内,无需依赖额外文件\n"
            "· 授权文件放到打包后 exe 的同一目录")).grid(row=10, column=0, columnspan=3, padx=14, sticky="w")

        self.secret_entry.bind("<KeyRelease>", self.on_secret_changed)
        self.days_entry.bind("<KeyRelease>", self.on_days)
        self.expire_entry.bind("<KeyRelease>", self.on_expire)
        self.issue_entry.bind("<KeyRelease>", self.on_issue)

        self.auto_load()

    def get_secret(self) -> str:
        return self.secret_entry.get().strip()

    def update_secret_fp_display(self) -> None:
        sec = self.get_secret()
        if sec:
            fp = secret_fingerprint(sec)
            self.secret_fp_lbl.config(text=f"指纹: {fp} (与 Godot Dock 中指纹一致即可)", fg="#2E7D32")
        else:
            self.secret_fp_lbl.config(text="⚠ 密钥不能为空", fg="#D32F2F")

    def on_secret_changed(self, _event=None) -> None:
        self.update_secret_fp_display()

    def auto_load(self) -> None:
        self.update_secret_fp_display()
        self.load_project_auto()

    def apply_project(self, path: str, quiet: bool = False) -> None:
        sec = self.get_secret()
        if not sec:
            return
        try:
            name = read_project_name(path)
            code = project_code(name, sec)
        except AegisError as e:
            if not quiet:
                self.mb.showerror("错误", str(e))
            return
        self._set(self.project_entry, code)
        self.project_lbl.config(text=f"来自工程名 \"{name}\"", fg="#888888")

    def load_exe(self) -> None:
        path = self.fd.askopenfilename(title="选择导出的 exe", filetypes=[("可执行文件", "*.exe"), ("所有文件", "*.*")],
                                       initialdir=app_dir())
        if not path:
            return
        try:
            code, fp = read_exe_tag(path)
        except AegisError as e:
            self.mb.showerror("错误", str(e))
            return
        self._set(self.project_entry, code)
        sec = self.get_secret()
        if not sec:
            self.project_lbl.config(text=f"来自 exe · 密钥指纹 {fp} (未输入密钥)", fg="#888888")
        elif fp != secret_fingerprint(sec):
            msg = f"exe 内指纹 {fp} ≠ 当前密钥指纹 {secret_fingerprint(sec)}"
            self.project_lbl.config(text=f"来自 exe · ⚠ {msg}", fg="#D32F2F")
            self.mb.showwarning("密钥不一致", msg + "\n\n请确认当前密钥是否正确。")
        else:
            self.project_lbl.config(text=f"来自 exe · 密钥指纹 {fp} ✓ 与当前密钥一致", fg="#2E7D32")

    def load_project(self) -> None:
        if not self.get_secret():
            self.mb.showwarning("提示", "请先输入或选择密钥。")
            return
        path = self.fd.askopenfilename(title="选择 project.godot", filetypes=[("Godot 工程", "project.godot"), ("所有文件", "*.*")],
                                       initialdir=app_dir())
        if path:
            self.apply_project(path)

    def _issue_date(self):
        try:
            return parse_date(self.issue_entry.get(), "")
        except AegisError:
            return None

    def on_days(self, _event=None) -> None:
        s, base = self.days_entry.get().strip(), self._issue_date()
        if s.isdigit() and base:
            try:
                self._set(self.expire_entry, (base + timedelta(days=int(s))).isoformat())
            except (OverflowError, ValueError):
                pass

    def on_expire(self, _event=None) -> None:
        base = self._issue_date()
        text = self.expire_entry.get().strip()
        if base and DATE_RE.match(text):
            try:
                diff = (parse_date(text, "") - base).days
            except AegisError:
                return
            if diff >= 0:
                self._set(self.days_entry, str(diff))

    def on_issue(self, _event=None) -> None:
        if self.days_entry.get().strip().isdigit():
            self.on_days()
        else:
            self.on_expire()

    def on_generate(self) -> None:
        mb = self.mb
        sec = self.get_secret()
        if not sec:
            mb.showwarning("警告", "密钥不能为空！")
            return
        code = self.project_entry.get().strip().lower()
        if not ID_RE.match(code):
            mb.showwarning("警告", "项目 ID 应为 10 位小写十六进制。\n可粘贴 Godot Dock 里的项目 ID 或从 exe 自动读取。")
            return
        try:
            issue = parse_date(self.issue_entry.get(), "签发日期")
            if not self.expire_entry.get().strip():
                raise AegisError("请填写到期日期或授权天数。")
            expire = parse_date(self.expire_entry.get(), "到期日期")
            if issue > expire:
                raise AegisError("签发日期不能晚于到期日期。")
        except AegisError as e:
            mb.showwarning("警告", str(e))
            return
        if expire < date.today() and not mb.askyesno("确认", "到期日期早于今天,该授权生成后立即处于已到期状态。\n仅用于测试到期流程,是否继续?"):
            return
        out_dir = self.fd.askdirectory(title="选择保存目录", initialdir=app_dir())
        if not out_dir:
            return
        filename = self.filename_entry.get().strip() or "license.dat"
        target = os.path.join(out_dir, os.path.basename(filename))
        if os.path.exists(target) and not mb.askyesno("确认", f"文件已存在,是否覆盖?\n{target}"):
            return
        customer = self.customer_entry.get().strip()
        try:
            path = write_license(out_dir, filename, code, sec, issue, expire, customer)
        except AegisError as e:
            mb.showerror("错误", str(e))
            return
        mb.showinfo("生成成功", f"授权文件生成成功 ✅\n\n客户 / 备注 : {customer or '-'}\n项目 ID : {code}\n"
                                f"签发日期 : {issue}\n到期日期 : {expire} (含当天)\n文件路径 : {path}\n\n"
                                "已通过解密回读自检。把文件放到打包后 exe 的同一目录即可。")
        reveal_in_explorer(path)

    # 新增：重置默认密钥的响应函数
    def reset_default_secret(self) -> None:
        self._set(self.secret_entry, DEFAULT_SHARED_SECRET)
        self.update_secret_fp_display()
        self.load_project_auto()

    # 新增：拆分出的自动加载工程逻辑
    def load_project_auto(self) -> None:
        proj = find_file(PROJECT_REL)
        if proj and self.get_secret():
            self.apply_project(proj, quiet=True)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--hash":
        print(hashlib.sha256(sys.argv[2].encode("utf-8")).hexdigest())
        return
    App().root.mainloop()


if __name__ == "__main__":
    main()