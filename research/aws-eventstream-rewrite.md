# AWS EventStream 帧实现重写记录

日期：2026-10-07。对应公开前清单中的二进制帧模块子项；不包含 Kiro 登录、客户端身份、JSON 信封或真实服务验收。

## 独立来源与实现范围

规范事实由另一位审查者仅从 [Smithy EventStream 规范](https://smithy.io/2.0/aws/amazon-eventstream.html)、[AWS 编码说明](https://docs.aws.amazon.com/lexv2/latest/dg/event-stream-encoding.html)及其引用的 [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952.html)提取。实现者依据该合同及仓库调用签名完整替换模块，没有读取旧解析器实现或按旧代码逐行改写。审查再对照新源码和合同进行。

现有 `decodeEventStream(stream)` 与 `encodeMessage(stringHeaders, payload)` 保留。消息仍有字符串 `headers` 和原始 `payload`；新增 `headerValues` 保留所有类型，64 位整数/时间为 BigInt，UUID 为规范字符串。`encodeTypedMessage` 供合成测试和明确的互操作使用，生产 Kiro 路径只解码。

帧使用大端长度字段。前导 CRC 覆盖最初八字节；消息 CRC 覆盖除末尾校验值外的完整帧，包含前导 CRC。两处均验证后才产出该消息。名称严格 UTF-8 且每帧唯一；未知类型、越界字段、无效 UTF-8、残帧或校验失败终止读取。CRC 是错误检测，不是身份认证；现有上游鉴权和 TLS 边界仍由来源适配器负责。

规范的时间类型表和伪码在有符号性上不一致，本实现按伪码使用 signed int64 并保留精度。变长字段按实际 u16 宽度解析，不把伪码里较窄的示例范围误加为客户端限制。

## 明确的本地资源策略

以下是本实现的资源上限，不是将服务端限制强加给客户端：

| 限制 | 默认值 | 含义 |
| --- | --- | --- |
| maxFrameBytes | 32 MiB | 单个完整帧；验证前导 CRC 后、分配前检查 |
| maxChunkBytes | 32 MiB | 调用方交来的单个运输分片；不是总 JS heap 承诺 |
| maxStreamBytes | 64 MiB | 整条流累计收到的字节数 |
| maxMessages | 100,000 | 消息数量，包括空消息 |
| maxHeaders | 1,024 | 每帧字段数 |

解析器只保留当前运输分片和正在验证的帧，不反复拼接整个历史。输出字节副本、解码后的字符串及调用方保留的数据会另占内存，因此不能把上表说成进程总内存上限。连续超过 1,024 个空分片也会终止。官方服务端的头部大小限制不是客户端校验规则；测试明确接受超过 128 KiB、仍在本地资源策略内的头部。

主动取消在等待读取之后和已缓冲帧产出之前再次检查。提前停止迭代会取消并释放 reader，不等待不合作的 cancel Promise。错误不包含头名称、payload、原始运输异常或 signal.reason。

## 独立金标与验收

使用 Python 标准库 `struct` 和 `zlib.crc32` 独立生成金标，而非只依赖新编码器与新解码器相互验证：

- 空帧：`000000100000000005c248eb7d98c8ff`
- 无头部、payload 为 hello：`0000001500000000cd22c79b68656c6c6f570c3496`
- CRC 检查向量 123456789：`cbf43926`

16 项新纯测试覆盖全部十个 wire tag、每个分片位置、粘包、CRC、截断、恶意长度、重复名、UTF-8、资源上限、reader 取消及已缓冲取消时序。连同既有 Kiro 和中立订阅假服务测试共 31 项通过；独立审查复验了取消问题的修复。

旧实现的历史来源和 MIT 许可证仍保留在 `PROVENANCE.md` 与 `third_party/opencodex/LICENSE`。这只关闭帧模块重写子项，不表示其余 Kiro/订阅协议、价格、预设或公开发布清单完成。本次没有读取真实凭据、连接真实 Kiro、生成公开快照或发布仓库。
