import tkinter as tk
from tkinter import messagebox, filedialog
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes
import base64
import json
import os
import subprocess
import hashlib
import uuid
from datetime import datetime, date, timedelta

# =========================
# 安全配置区（重要：请在首次使用前修改）
# =========================
# 登录密码只保存哈希值，源码里看不到明文密码。
# 生成新密码哈希的方法：在终端执行
#   python -c "import hashlib;print(hashlib.sha256('你的新密码'.encode()).hexdigest())"
# 然后把结果填到下面这一行。
ADMIN_PASSWORD_HASH = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92" # 请替换为你新密码的sha256哈希值

# 系统级固定常量，用于和"项目标识"一起派生盐值。
# 这个值本身不是保密核心（真正的机密是登录密码），但请换成你自己的新字符串，
# 不要沿用任何在旧版本中出现过的常量。
STATIC_PEPPER = b"REPLACE-THIS-WITH-YOUR-OWN-RANDOM-PEPPER-V2"

PBKDF2_ITERATIONS = 200_000
AES_KEY_LEN = 32  # AES-256

# 登录成功后，密码仅保存在内存中用于派生密钥，绝不落盘、绝不打印
CURRENT_PASSWORD = None


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
# 密钥派生：密码 + 项目标识 -> 该项目专属 AES-256 密钥
# =========================
def derive_key(password: str, project_code: str) -> bytes:
    salt = hashlib.sha256(project_code.encode("utf-8") + STATIC_PEPPER).digest()
    key = PBKDF2(
        password,
        salt,
        dkLen=AES_KEY_LEN,
        count=PBKDF2_ITERATIONS,
        hmac_hash_module=SHA256,
    )
    return key


# =========================
# 授权文件生成函数
# =========================
def generate_license(password: str, project_code: str, output_name: str,
                      expire_date: str, issue_date: str = None, output_dir: str = None):
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

        key = derive_key(password, project_code)
        iv = get_random_bytes(16)

        cipher = AES.new(key, AES.MODE_CBC, iv)
        encrypted = cipher.encrypt(pad(json_text.encode("utf-8"), AES.block_size))

        # IV 明文附加在密文前面（这是标准做法，IV 不需要保密），
        # Godot 端解密时会先取出前 16 字节作为 IV。
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


# =========================
# 天数计算与输入联动
# =========================
def calculate_expire_from_days(event=None):
    days_str = days_entry.get().strip()
    if not days_str:
        return
    if days_str.isdigit():
        days = int(days_str)
        calculated_expire = date.today() + timedelta(days=days)
        date_entry.delete(0, tk.END)
        date_entry.insert(0, calculated_expire.isoformat())
    else:
        messagebox.showwarning("提示", "授权天数请输入正整数！")


# =========================
# 主界面：生成授权文件
# =========================
def on_generate():
    if CURRENT_PASSWORD is None:
        messagebox.showerror("错误", "登录状态异常，请重新打开程序。")
        return

    project_code = project_entry.get().strip()
    if not project_code:
        messagebox.showwarning("警告", "请填写项目标识！同一个项目请始终使用同一个标识。")
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
        CURRENT_PASSWORD, project_code, output_name, expire_date, issue_date, output_dir
    )
    if path:
        msg = f"""授权文件生成成功 ✅

项目标识 : {project_code}
签发日期 : {issue_date}
到期日期 : {expire_date}
加密字节 : {enc_len}  Base64长度 : {b64_len}
文件路径 : {abs_path}

请确认该项目的 Godot 插件里已放入
与此项目标识匹配的 license_key.gd
"""
        messagebox.showinfo("生成成功", msg)
        open_in_explorer(path)


# =========================
# 主界面：导出该项目对应的 Godot 密钥文件
# =========================
def on_export_key():
    if CURRENT_PASSWORD is None:
        messagebox.showerror("错误", "登录状态异常，请重新打开程序。")
        return

    project_code = project_entry.get().strip()
    if not project_code:
        messagebox.showwarning("提示", "请先填写项目标识，再导出对应的密钥文件！")
        return

    key = derive_key(CURRENT_PASSWORD, project_code)
    key_b64 = base64.b64encode(key).decode("ascii")

    gd_content = f'''extends RefCounted
class_name LicenseKeyData

## 本文件由 license_generator.py 自动生成
## 对应项目标识: {project_code}
## 请勿跨项目复制使用，每个项目必须有自己独立的一份

const PROJECT_CODE := "{project_code}"
const DERIVED_KEY_B64 := "{key_b64}"
'''

    save_path = filedialog.asksaveasfilename(
        title="保存 license_key.gd",
        initialfile="license_key.gd",
        defaultextension=".gd",
        filetypes=[("GDScript", "*.gd")],
    )
    if not save_path:
        return

    with open(save_path, "w", encoding="utf-8") as f:
        f.write(gd_content)

    messagebox.showinfo(
        "导出成功",
        f"已生成 license_key.gd\n项目标识: {project_code}\n\n"
        f"请将此文件放入该 Godot 项目的\naddons/license_manager/ 目录下，覆盖模板文件，\n"
        f"然后再重新导出授权文件给这个项目使用。",
    )
    open_in_explorer(save_path)


# =========================
# 密码验证（只比对哈希，源码不含明文密码）
# =========================
def check_password(event=None):
    global CURRENT_PASSWORD
    pwd = password_entry.get()
    pwd_hash = hashlib.sha256(pwd.encode("utf-8")).hexdigest()
    if pwd_hash != ADMIN_PASSWORD_HASH:
        messagebox.showerror("错误", "密码错误！")
        return
    CURRENT_PASSWORD = pwd
    password_window.destroy()
    show_main_window()


# =========================
# 主窗口
# =========================
def show_main_window():
    global main_window, date_entry, days_entry, filename_entry, issue_value, project_entry
    main_window = tk.Tk()
    main_window.title("授权文件生成器 v2")

    center_window(main_window, 440, 430)
    main_window.resizable(False, False)

    issue_value = tk.StringVar(value=date.today().isoformat())

    tk.Label(main_window, text="签发日期 (自动，本机当前日期):").pack(pady=(12, 2))
    tk.Label(main_window, textvariable=issue_value, fg="#555555").pack()

    tk.Label(main_window, text="项目标识 (每个项目/客户必须唯一且固定):").pack(pady=(10, 2))
    project_entry = tk.Entry(main_window, width=30)
    project_entry.pack()

    tk.Label(main_window, text="授权天数 (输入天数将自动计算到期日期):").pack(pady=(10, 2))
    days_entry = tk.Entry(main_window, width=30)
    days_entry.pack()
    days_entry.bind("<KeyRelease>", calculate_expire_from_days)

    tk.Label(main_window, text="到期日期 (YYYY-MM-DD):").pack(pady=(10, 2))
    date_entry = tk.Entry(main_window, width=30)
    date_entry.pack()

    tk.Label(main_window, text="文件名 (可选, 默认 license.dat):").pack(pady=(10, 2))
    filename_entry = tk.Entry(main_window, width=30)
    filename_entry.pack()

    generate_btn = tk.Button(
        main_window, text="生成授权文件 (license.dat)", command=on_generate,
        bg="#4CAF50", fg="white", width=28,
    )
    generate_btn.pack(pady=(18, 6))

    export_key_btn = tk.Button(
        main_window, text="导出该项目的 Godot 密钥文件 (license_key.gd)", command=on_export_key,
        bg="#2196F3", fg="white", width=36,
    )
    export_key_btn.pack(pady=(0, 10))


    main_window.mainloop()


# =========================
# 密码窗口
# =========================
password_window = tk.Tk()
password_window.title("管理员验证")

center_window(password_window, 400, 200)
password_window.resizable(False, False)

tk.Label(password_window, text="请输入管理员密码:").pack(pady=(20, 5))
password_entry = tk.Entry(password_window, show="*", width=25)
password_entry.pack()
password_entry.bind("<Return>", check_password)

tk.Button(password_window, text="确认", command=check_password, bg="#2196F3", fg="white", width=15).pack(pady=20)

password_window.mainloop()
