import buildInfo from '../content/public/build-info.json';

export function VersionNotice() {
  return (
    <p className="version-notice">
      文档对应源码提交：{' '}
      <a
        href={`https://github.com/tuuject/surowan/commit/${buildInfo.commit}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <code>{buildInfo.commit.slice(0, 12)}</code>
      </a>
      {buildInfo.dirty ? '（含未提交修改，仅供本地预览）' : '。请先与自己的部署版本核对。'}
    </p>
  );
}
