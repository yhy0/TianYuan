import type { ReactNode } from "react";
import sprite from "./assets/tianyuan-sprite.svg?raw";

/** 与界法七阶同名。16px 及以下用微型印，其余用标准印。 */
const SEALS = [
  { level: 1, slug: "kouque", name: "叩阙", min: 0, realm: "入世寻道", line: "叩阙而入，初识界门" },
  { level: 2, slug: "xuntian", name: "巡天", min: 200, realm: "入世寻道", line: "巡天而行，遍观诸道" },
  { level: 3, slug: "zhuyou", name: "烛幽", min: 500, realm: "立道成宗", line: "烛幽而明，照见幽微" },
  { level: 4, slug: "daozong", name: "道宗", min: 3000, realm: "立道成宗", line: "立道成宗，诸家可循" },
  { level: 5, slug: "kaitian", name: "开天", min: 8000, realm: "诸天执序", line: "天地初分，开辟前人未有之道" },
  { level: 6, slug: "beichen", name: "北辰", min: 20000, realm: "诸天执序", line: "众星拱极，诸家所宗" },
  { level: 7, slug: "siming", name: "司命", min: 50000, realm: "诸天执序", line: "万象命轮，界中至高的传说" },
] as const;

const ORDINAL = ["一", "二", "三", "四", "五", "六", "七"];

export function sealOf(rank?: string | null) {
  return SEALS.find((item) => item.name === rank) ?? SEALS[0];
}

export function SealSprite() {
  return <div className="seal-defs" aria-hidden="true" dangerouslySetInnerHTML={{ __html: sprite }} />;
}

export function DaoSeal({
  rank,
  size = 20,
  decorative = false,
  earned,
  place = "above",
  focusable = false,
}: {
  rank?: string | null;
  size?: number;
  decorative?: boolean;
  earned?: number;
  place?: "above" | "below";
  focusable?: boolean;
}) {
  const info = sealOf(rank);
  const px = size <= 16 ? 16 : size;
  const id = px <= 16 ? `ty-${info.slug}-micro` : `ty-${info.slug}`;
  const ordinal = ORDINAL[info.level - 1] ?? String(info.level);
  const summary = `${info.name}，第${ordinal}阶，${info.realm}，道韵 ${info.min.toLocaleString("zh-CN")} 起。${info.line}`;
  return (
    <span className={place === "below" ? "seal-host below" : "seal-host"} tabIndex={focusable ? 0 : undefined}>
      <svg className="seal" width={px} height={px} role={decorative ? undefined : "img"} aria-label={decorative ? undefined : summary} aria-hidden={decorative ? true : undefined} focusable="false">
        <use href={`#${id}`} width="100%" height="100%" />
      </svg>
      <span className="seal-pop" role="tooltip" aria-hidden="true">
        <b>{info.name}</b>
        <span>第{ordinal}阶 · {info.realm}</span>
        <span>道韵 {info.min.toLocaleString("zh-CN")} 起</span>
        {earned != null ? <span>累积 {Math.floor(earned).toLocaleString("zh-CN")}</span> : null}
        <span className="seal-line">{info.line}</span>
      </span>
    </span>
  );
}

export function DaoAvatar({ name, rank, earned, size = 40 }: { name: string; rank?: string | null; earned?: number; size?: number }) {
  const glyph = Array.from(name)[0] || "界";
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {glyph}
      <span className="avatar-seal">
        <DaoSeal rank={rank} size={size >= 36 ? 20 : 16} decorative earned={earned} place="below" />
      </span>
    </span>
  );
}

export function RankMark({ rank, size = 20, earned, quiet = false }: { rank?: string | null; size?: number; earned?: number; quiet?: boolean }) {
  const info = sealOf(rank);
  return (
    <span className={quiet ? "rank-mark quiet" : "rank-mark"}>
      <DaoSeal rank={info.name} size={size} decorative earned={earned} />
      <span>{info.name}</span>
    </span>
  );
}

export function ProfileSeal({ rank, earned, size = 96, hero = false, children }: { rank?: string | null; earned?: number; size?: number; hero?: boolean; children: ReactNode }) {
  return (
    <div className={hero ? "hero profile" : "profile"}>
      <DaoSeal rank={rank} size={size} earned={earned} focusable />
      <div className="profile-copy">{children}</div>
    </div>
  );
}
