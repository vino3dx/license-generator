import base64
import hashlib
import json
import os
import subprocess
import uuid
from datetime import date, datetime, timedelta

import tkinter as tk
from tkinter import filedialog, messagebox

from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from Crypto.Util.Padding import pad

# =========================
# 安全配置区
# =========================
# 管理员登录密码哈希（默认密码 123456 的 SHA256 值）
ADMIN_PASSWORD_HASH = (
    "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
)

# 统一解密秘盐（须与 Godot 端的 SHARED_SECRET 保持完全一致）
SHARED_SECRET = "MyStudio_Secret_2026"

# 登录状态标记
IS_LOGGED_IN = False

# 全局 UI 控件声明（消除静态语法检查警告）
main_window = None
date_entry = None
days_entry = None
filename_entry = None
issue_value = None
project_entry = None


# =========================
# 通用函数：窗口屏幕居中
# =========================
def center_window(window, width, height):
    window.update_idletasks()
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2
    window.geometry(f"{width}x{height}+{x}+{y}")


# =========================
# 密钥派生：项目标识 + SHARED_SECRET -> AES-256 密钥
# =========================
def derive_key(project_code: str) -> bytes:
    raw_bytes = (project_code.strip() + SHARED_SECRET).encode("utf-8")
    return hashlib.sha256(raw_bytes).digest()


# =========================
# 授权文件生成函数
# =========================
def generate_license(
    project_code: str,
    output_name: str,
    expire_date: str,
    issue_date: str = None,
    output_dir: str = None,
):
    try:
        if not project_code:
            messagebox.showerror("错误", "项目标识不能为空！")
            return None, None, None, None, None

        if issue_date is None:
            issue_date = date.today().isoformat()

        issue_dt = datetime.strptime(issue_date, "%Y-%m-%d")
        expire_dt = datetime.strptime(expire_date, "%Y-%m-%d")
        if issue_dt > expire_dt:
            messagebox.showerror("错误", "签发日期不能晚于到期日期！")
            return None, None, None, None, None

        data = {
            "issue": issue_date,
            "expire": expire_date,
            "project": project_code,
            "license_id": str(uuid.uuid4()),
        }
        json_text = json.dumps(data, separators=(",", ":"))

        key = derive_key(project_code)
        iv = get_random_bytes(16)

        cipher = AES.new(key, AES.MODE_CBC, iv)
        encrypted = cipher.encrypt(pad(json_text.encode("utf-8"), AES.block_size))

        payload = iv + encrypted
        encoded = base64.b64encode(payload)

        if output_dir is None:
            output_dir = os.path.dirname(os.path.abspath(__file__))

        file_path = os.path.join(output_dir, output_name)

        with open(file_path, "wb") as f:
            f.write(encoded)

        abs_path = os.path.abspath(file_path)
        return file_path, abs_path, json_text, len(encrypted), len(encoded)
    except ValueError:
        messagebox.showerror("错误", "日期格式错误，请使用 YYYY-MM-DD")
        return None, None, None, None, None
    except Exception as e:
        messagebox.showerror("错误", str(e))
        return None, None, None, None, None


def open_in_explorer(file_path: str):
    abs_path = os.path.abspath(file_path)
    try:
        subprocess.Popen(f'explorer /select,"{abs_path}"')
    except Exception:
        pass


### =========================
### 天数与到期日期双向联动
### =========================
def calculate_expire_from_days(event=None):
    days_str = days_entry.get().strip()
    if not days_str:
        return
    if days_str.isdigit():
        days = int(days_str)
        calculated_expire = date.today() + timedelta(days=days)
        date_entry.delete(0, tk.END)
        date_entry.insert(0, calculated_expire.isoformat())

def calculate_days_from_expire(event=None):
    date_str = date_entry.get().strip()
    if not date_str:
        return
    # 只有当输入的字符串达到 10 位（如 YYYY-MM-DD）时才尝试计算天数
    if len(date_str) == 10:
        try:
            target_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            today = date.today()
            diff_days = (target_date - today).days
            if diff_days >= 0:
                days_entry.delete(0, tk.END)
                days_entry.insert(0, str(diff_days))
        except ValueError:
            pass  # 格式未输完整或非法时静默忽略，避免打字中断


# =========================
# 主界面：生成授权文件
# =========================
def on_generate():
    if not IS_LOGGED_IN:
        messagebox.showerror("错误", "未通过管理员验证！")
        return

    project_code = project_entry.get().strip()
    if not project_code:
        messagebox.showwarning("警告", "请填写项目标识！")
        return

    expire_date = date_entry.get().strip()
    if not expire_date:
        messagebox.showwarning("警告", "请填写到期日期或授权天数！")
        return

    issue_date = issue_value.get().strip()

    output_name = filename_entry.get().strip()
    if not output_name:
        output_name = "license.dat"

    output_dir = filedialog.askdirectory(title="选择保存目录")
    if not output_dir:
        return

    path, abs_path, json_text, enc_len, b64_len = generate_license(
        project_code, output_name, expire_date, issue_date, output_dir
    )
    if path:
        msg = f"""授权文件生成成功 ✅

项目标识 : {project_code}
签发日期 : {issue_date}
到期日期 : {expire_date}
加密字节 : {enc_len}    Base64长度 : {b64_len}
文件路径 : {abs_path}

可以直接将授权文件复制到打包后的 Godot exe 根目录下。
"""
        messagebox.showinfo("生成成功", msg)
        open_in_explorer(path)


# =========================
# 密码验证（管理员门禁校验）
# =========================
def check_password(event=None):
    global IS_LOGGED_IN
    pwd = password_entry.get()
    pwd_hash = hashlib.sha256(pwd.encode("utf-8")).hexdigest()
    if pwd_hash != ADMIN_PASSWORD_HASH:
        messagebox.showerror("错误", "密码错误，无法进入系统！")
        return
    IS_LOGGED_IN = True
    password_window.destroy()
    show_main_window()


# =========================
# 主窗口
# =========================
def show_main_window():
    global main_window, date_entry, days_entry, filename_entry, issue_value, project_entry

    main_window = tk.Tk()
    main_window.title("授权文件生成器 v2")

    center_window(main_window, 440, 380)
    main_window.resizable(False, False)

    issue_value = tk.StringVar(value=date.today().isoformat())

    tk.Label(main_window, text="签发日期 (自动，本机当前日期):").pack(pady=(12, 2))
    tk.Label(main_window, textvariable=issue_value, fg="#555555").pack()

    tk.Label(main_window, text="项目标识 (粘贴 Godot 端的 Project ID):").pack(pady=(10, 2))
    project_entry = tk.Entry(main_window, width=30)
    project_entry.pack()

    tk.Label(main_window, text="授权天数 (输入天数将自动计算到期日期):").pack(pady=(10, 2))
    days_entry = tk.Entry(main_window, width=30)
    days_entry.pack()
    days_entry.bind("<KeyRelease>", calculate_expire_from_days)

    tk.Label(main_window, text="到期日期 (YYYY-MM-DD):").pack(pady=(10, 2))
    date_entry = tk.Entry(main_window, width=30)
    date_entry.pack()
    date_entry.bind("<KeyRelease>", calculate_days_from_expire)

    tk.Label(main_window, text="文件名 (可选, 默认 license.dat):").pack(pady=(10, 2))
    filename_entry = tk.Entry(main_window, width=30)
    filename_entry.pack()

    generate_btn = tk.Button(
        main_window,
        text="生成授权文件 (license.dat)",
        command=on_generate,
        bg="#4CAF50",
        fg="white",
        width=28,
    )
    generate_btn.pack(pady=(18, 10))

    tk.Label(
        main_window,
        text="提示：粘贴 Project ID 即可生成，无需导出密钥文件。",
        fg="#888888",
        justify="center",
    ).pack(pady=(4, 4))

    main_window.mainloop()


# =========================
# 程序启动入口（首先进入密码验证框）
# =========================
password_window = tk.Tk()
password_window.title("管理员验证")

center_window(password_window, 400, 200)
password_window.resizable(False, False)

tk.Label(password_window, text="请输入管理员密码:").pack(pady=(20, 5))
password_entry = tk.Entry(password_window, show="*", width=25)
password_entry.pack()
password_entry.bind("<Return>", check_password)

tk.Button(
    password_window,
    text="确认登录",
    command=check_password,
    bg="#2196F3",
    fg="white",
    width=15,
).pack(pady=20)

password_window.mainloop()