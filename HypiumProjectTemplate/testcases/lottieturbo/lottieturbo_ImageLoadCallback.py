# !/usr/bin/env python
# coding: utf-8
"""
#!!================================================================
#版权 (C) 2023, Huawei Technologies Co.
#==================================================================
#文 件 名：                 Example.py
#文件说明：                 Example TestScript
#作    者：                 xiatian
#生成日期：                 2026-08-22
#!!================================================================
"""

from devicetest.core.test_case import TestCase, Step
from hypium import *
from hypium.model import UiParam


class lottieturbo_ImageLoadCallback(TestCase):
    def __init__(self, controllers):
        self.TAG = self.__class__.__name__
        TestCase.__init__(self, self.TAG, controllers)
        self.driver = UiDriver(self.device1)

    def setup(self):
        Step('1.杀掉lottieturbo应用')
        self.driver.stop_app("com.openharmony.lottieturbo")
        Step('2.启动lottieturbo应用')
        self.driver.start_app(package_name="com.openharmony.lottieturbo")
        Step('3.下滑进入ImageLoadCallback页面')
        self.driver.wait(1)
        self.driver.swipe(UiParam.UP, distance=60, start_point=(632, 2139))
        self.driver.wait(1)
        self.driver.swipe(UiParam.UP, distance=60, start_point=(632, 2139))
        self.driver.wait(1)

    def process(self):
        Step('4.1000循环')
        scenes = [
            "场景1: base64 图片正常加载",
            "场景2: URL 图片正常加载",
            "场景3: 文件路径图片正常加载",
            "场景4: URL 图片加载失败（无效地址）",
            "场景5: 纯矢量动画资源-success",
            "场景6: 纯矢量动画资源(ip>op)-fail",
            "场景7: 纯矢量动画资源(缺少 layers)-fail",
            "场景8: 纯矢量动画资源(JSON 语法错误)-fail",
            "场景9: 同时加载两个动画(1成功1失败)",
            "场景10: imageProvider为null",
            "场景11: 动画路径为空字符串",
            "场景12: 同时加载5个动画(大数据)",
            "场景13: 同时加载10个动画(大数据)",
        ]
        for i in range(30):
            for scene in scenes:
                self.driver.touch(BY.text("ImageLoadCallback"))
                self.driver.touch(BY.text(scene))
                self.driver.swipe_to_back()

    def teardown(self):
        Step('3.关闭设置应用')
        self.driver.stop_app("com.openharmony.lottieturbo")
        self.driver.wait(1)
