export interface FavoriteArt {
  png: string;
  kind: "cover" | "mark";
  width: number;
  height: number;
}

export interface SiteIcons {
  favicon?: string;
  favoriteArt?: FavoriteArt;
}
