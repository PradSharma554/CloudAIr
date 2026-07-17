package crawler

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
)

type sitemapURLSet struct {
	URLs []struct {
		Loc string `xml:"loc"`
	} `xml:"url"`
}

type sitemapIndex struct {
	Sitemaps []struct {
		Loc string `xml:"loc"`
	} `xml:"sitemap"`
}

const maxSitemapSeeds = 200

// fetchSitemap seeds the frontier from /sitemap.xml, following one level of
// sitemap-index nesting.
func (c *Crawler) fetchSitemap(ctx context.Context, baseURL string) []string {
	return c.fetchSitemapURL(ctx, baseURL+"/sitemap.xml", 0)
}

func (c *Crawler) fetchSitemapURL(ctx context.Context, sitemapURL string, depth int) []string {
	if depth > 1 {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sitemapURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return nil
	}

	var urls []string
	var set sitemapURLSet
	if err := xml.Unmarshal(body, &set); err == nil && len(set.URLs) > 0 {
		for _, u := range set.URLs {
			urls = append(urls, u.Loc)
			if len(urls) >= maxSitemapSeeds {
				return urls
			}
		}
		return urls
	}
	var idx sitemapIndex
	if err := xml.Unmarshal(body, &idx); err == nil {
		for _, sm := range idx.Sitemaps {
			urls = append(urls, c.fetchSitemapURL(ctx, sm.Loc, depth+1)...)
			if len(urls) >= maxSitemapSeeds {
				return urls[:maxSitemapSeeds]
			}
		}
	}
	return urls
}
