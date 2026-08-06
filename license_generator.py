import tkinter as tk
from tkinter import messagebox, filedialog
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import base64
import json
import os
import subprocess
from datetime import datetime, date, timedelta

# =========================
# AES 配置
# =========================
KEY = b"1234567890ABCDEF1234567890ABCDEF"
IV  = b"ABCDEF1234567890"

ADMIN_PASSWORD = "Mzkj112233"

# =========================
# 通用函数：窗口屏幕居中
# =========================
def center_window(window, width, height):
    """将 tkinter 窗口在屏幕中央居中显示"""
    window.update_idletasks()
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2
    window.geometry(f"{width}x{height}+{x}+{y}")

# =========================
# 授权文件生成函数
# =========================
def generate_license(output_name: str, expire_date: str, issue_date: str = None, output_dir: str = None):
    try:
        if issue_date is None:
            issue_date = date.today().isoformat()

        # 基本合法性检查：签发日期不能晚于到期日期
        issue_dt = datetime.strptime(issue_date, "%Y-%m-%d")
        expire_dt = datetime.strptime(expire_date, "%Y-%m-%d")
        if issue_dt > expire_dt:
            messagebox.showerror("错误", "签发日期不能晚于到期日期！")
            return None, None, None, None, None

        data = {"issue": issue_date, "expire": expire_date}
        json_text = json.dumps(data, separators=(',', ':'))

        cipher = AES.new(KEY, AES.MODE_CBC, IV)
        encrypted = cipher.encrypt(pad(json_text.encode("utf-8"), AES.block_size))
        encoded = base64.b64encode(encrypted)

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
    subprocess.Popen(f'explorer /select,"{abs_path}"')

# =========================
# 天数计算与输入联动
# =========================
def calculate_expire_from_days(event=None):
    """根据输入的授权天数自动计算并填入到期日期"""
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
# 主界面生成按钮回调
# =========================
def on_generate():
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

    path, abs_path, json_text, enc_len, b64_len = generate_license(output_name, expire_date, issue_date, output_dir)
    if path:
        msg = f"""授权文件生成成功 ✅

签发日期 : {issue_date}
到期日期 : {expire_date}
原始JSON : {json_text}
加密字节 : {enc_len}  Base64长度 : {b64_len}
文件路径 : {abs_path}
"""
        messagebox.showinfo("生成成功", msg)
        open_in_explorer(path)

# =========================
# 密码验证
# =========================
def check_password(event=None):
    pwd = password_entry.get()
    if pwd != ADMIN_PASSWORD:
        messagebox.showerror("错误", "密码错误！")
        return
    password_window.destroy()
    show_main_window()

# =========================
# 主窗口
# =========================
def show_main_window():
    global main_window, date_entry, days_entry, filename_entry, issue_value
    main_window = tk.Tk()
    main_window.title("授权文件生成器")
    
    # 居中设置 420x330 大小的窗口
    center_window(main_window, 420, 330)
    main_window.resizable(False, False)

    issue_value = tk.StringVar(value=date.today().isoformat())

    # 签发日期
    tk.Label(main_window, text="签发日期 (自动，本机当前日期):").pack(pady=(15, 2))
    tk.Label(main_window, textvariable=issue_value, fg="#555555").pack()

    # 授权天数输入框
    tk.Label(main_window, text="授权天数 (输入天数将自动计算到期日期):").pack(pady=(10, 2))
    days_entry = tk.Entry(main_window, width=30)
    days_entry.pack()
    days_entry.bind("<KeyRelease>", calculate_expire_from_days)

    # 到期日期输入框
    tk.Label(main_window, text="到期日期 (YYYY-MM-DD):").pack(pady=(10, 2))
    date_entry = tk.Entry(main_window, width=30)
    date_entry.pack()

    # 文件名
    tk.Label(main_window, text="文件名 (可选, 默认 license.dat):").pack(pady=(10, 2))
    filename_entry = tk.Entry(main_window, width=30)
    filename_entry.pack()

    # 生成按钮
    generate_btn = tk.Button(main_window, text="生成授权文件", command=on_generate, bg="#4CAF50", fg="white", width=20)
    generate_btn.pack(pady=20)

    main_window.mainloop()

# =========================
# 密码窗口
# =========================
password_window = tk.Tk()
password_window.title("管理员验证")

# 居中设置 400x200 大小的窗口
center_window(password_window, 400, 200)
password_window.resizable(False, False)

tk.Label(password_window, text="请输入管理员密码:").pack(pady=(20, 5))
password_entry = tk.Entry(password_window, show="*", width=25)
password_entry.pack()
# 支持回车直接提交密码
password_entry.bind("<Return>", check_password)

tk.Button(password_window, text="确认", command=check_password, bg="#2196F3", fg="white", width=15).pack(pady=20)

password_window.mainloop()