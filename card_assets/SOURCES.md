# card_assets 来源与版权说明

本目录只包含运行时的占位图和说明文件。卡牌原图不会随软件打包，而是
在用户请求某一张卡牌时，通过 HearthstoneJSON 的官方图片地址按需下载到
用户缓存目录。

`card_assets` 模块需要 Python 3.7 或更新版本；它不改变原有 Fireplace 模块
的安装版本要求。

## 图片服务

- 服务地址：<https://art.hearthstonejson.com>
- 图片接口文档：<https://hearthstonejson.com/docs/images.html>
- HearthstoneJSON 项目及其接口说明采用 CC0 贡献方式发布。

HearthstoneJSON 的 CC0 说明不涵盖 Hearthstone 卡牌图像本身。卡牌插画、
卡牌名称和卡牌规则文字属于 Blizzard Entertainment 及相关权利人；本项目
不主张拥有这些内容的版权。下载的卡牌图片只用于用户已请求的本地运行时
缓存，使用者需要自行遵守适用的服务条款和版权法。

## 本地卡牌文字

`CardDefs.xml` 来自 Fireplace 仓库，随仓库的 AGPLv3（或更高版本）许可
条款分发。`card_assets` 只读取其中 `CARDNAME` 和 `CARDTEXT` 的本地化字段，
不会导入 Fireplace 的运行时卡牌数据库。

## 占位图

`placeholder.png` 是本项目随附的简单占位资源，作为网络请求失败、资源不
存在或用户缓存不可写时的本地回退。它不是 Hearthstone 卡牌图片。
