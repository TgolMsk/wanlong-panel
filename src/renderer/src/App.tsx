/**
 * 面板根组件。
 * ⚠️ 当前是占位骨架，完整 UI 由「模块 f」补齐。
 */
import { Layout, Typography } from 'antd'

export default function App(): React.JSX.Element {
  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Header style={{ color: '#fff' }}>
        <Typography.Text style={{ color: '#fff', fontSize: 16 }}>万龙控制面板</Typography.Text>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Typography.Paragraph>
          地基已就绪。实例列表、脚本运行、实时日志、画面预览、模板截取工具由模块 f 实现。
        </Typography.Paragraph>
      </Layout.Content>
    </Layout>
  )
}
