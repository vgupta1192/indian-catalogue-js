const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const PORT = process.env.PORT || 7000;

const cache = new NodeCache({ stdTTL: 1800, checkperiod: 300, maxKeys: 1000 });

const manifest = {
  id: 'org.theatrical.catalogue.2024',
  version: '3.0.1',
  name: '🎬 Indian + Hollywood Catalogue',
  description: 'Latest theatrical releases with search',
  logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    {
      id: 'hollywood_latest',
      name: '🎥 Hollywood Movies',
      type: 'movie',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    },
    {
      id: 'indian_latest',
      name: '🇮🇳 Indian Movies',
      type: 'movie',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    },
    {
      id: 'hollywood_series_latest',
      name: '📺 TV Series',
      type: 'series',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    }
  ],
  behaviorHints: { 
    configurable: false,
    adult: false
  }
};

const builder = new addonBuilder(manifest);

function getISTDate() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istTime = new Date(utcTime + (3600000 * 5.5));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLanguageLabel(lang) {
  const map = {
    hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu',
    ml: 'Malayalam', kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', pa: 'Punjabi'
  };
  return map[lang] || lang.toUpperCase();
}

async function getIMDBId(tmdbId, type = 'movie') {
  const cacheKey = `imdb_${type}_${tmdbId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const endpoint = type === 'series' ? 'tv' : 'movie';
    const response = await axios.get(
      `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids`,
      { params: { api_key: TMDB_API_KEY }, timeout: 8000 }
    );
    const imdbId = response.data?.imdb_id || null;
    cache.set(cacheKey, imdbId, 86400);
    return imdbId;
  } catch {
    cache.set(cacheKey, null, 3600);
    return null;
  }
}

async function hasHindiAudio(movieId) {
  const cacheKey = `hindi_${movieId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const response = await axios.get(
      `https://api.themoviedb.org/3/movie/${movieId}`,
      { 
        params: { 
          api_key: TMDB_API_KEY, 
          append_to_response: 'translations,release_dates' 
        }, 
        timeout: 6000 
      }
    );

    const originalLang = response.data.original_language;
    if (originalLang === 'hi') {
      cache.set(cacheKey, true, 86400);
      return true;
    }

    const translations = response.data.translations?.translations || [];
    const hasHindiTrans = translations.some(t => t.iso_639_1 === 'hi');
    
    if (hasHindiTrans) {
      cache.set(cacheKey, true, 86400);
      return true;
    }

    const releaseDates = response.data.release_dates?.results || [];
    const indiaRelease = releaseDates.find(r => r.iso_3166_1 === 'IN');
    if (indiaRelease) {
      cache.set(cacheKey, true, 86400);
      return true;
    }

    cache.set(cacheKey, false, 3600);
    return false;
  } catch {
    cache.set(cacheKey, false, 3600);
    return false;
  }
}

function formatReleaseDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

async function formatMovie(movie) {
  if (!movie.poster_path) return null;
  const tmdbId = movie.id;
  if (!tmdbId) return null;
  const imdbId = await getIMDBId(tmdbId, 'movie');
  if (!imdbId) return null;
  const langLabel = getLanguageLabel(movie.original_language || '');
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '';
  const releaseDate = formatReleaseDate(movie.release_date);

  return {
    id: imdbId,
    type: 'movie',
    name: movie.title || movie.original_title || 'Unknown',
    poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
    posterShape: 'poster',
    background: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : undefined,
    description: movie.overview || 'No description',
    releaseInfo: releaseDate || (movie.release_date ? movie.release_date.substring(0, 4) : undefined),
    imdbRating: rating,
    language: langLabel
  };
}

async function formatSeries(series) {
  if (!series.poster_path) return null;
  const tmdbId = series.id;
  if (!tmdbId) return null;
  const imdbId = await getIMDBId(tmdbId, 'series');
  if (!imdbId) return null;
  const langLabel = getLanguageLabel(series.original_language || '');
  const rating = series.vote_average ? series.vote_average.toFixed(1) : '';
  const releaseDate = formatReleaseDate(series.first_air_date);

  return {
    id: imdbId,
    type: 'series',
    name: series.name || series.original_name || 'Unknown',
    poster: `https://image.tmdb.org/t/p/w500${series.poster_path}`,
    posterShape: 'poster',
    background: series.backdrop_path ? `https://image.tmdb.org/t/p/original${series.backdrop_path}` : undefined,
    description: series.overview || 'No description',
    releaseInfo: releaseDate || (series.first_air_date ? series.first_air_date.substring(0, 4) : undefined),
    imdbRating: rating,
    language: langLabel
  };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const searchQuery = extra.search || '';
  const skip = parseInt(extra.skip || 0, 10) || 0;

  // Base key for this catalog + search combination
  const pageSizeKeyBase = searchQuery ? `${id}_s_${searchQuery}` : `${id}`;
  const pageSizeKey = `ps_${pageSizeKeyBase}`;

  // Guess page size from cache, default 20 until we learn real size
  let pageSize = cache.get(pageSizeKey) || 20;

  // Derive TMDB page from how many items Stremio says it already has
  const page = Math.floor(skip / pageSize) + 1;

  const cacheKey = `${pageSizeKeyBase}_p${page}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`Cache: ${id} skip=${skip} p${page} pageSize=${pageSize}`);
    return { metas: cached, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
  }

  console.log(`Fetch: ${id} skip=${skip} p${page}${searchQuery ? ` q:${searchQuery}` : ''} pageSizeGuess=${pageSize}`);

  try {
    let metas = [];
    const todayIST = getISTDate();

    if (searchQuery) {
      if (type === 'movie') {
        const response = await axios.get('https://api.themoviedb.org/3/search/movie', {
          params: { api_key: TMDB_API_KEY, query: searchQuery, page: page },
          timeout: 12000
        });

        let movies = response.data.results || [];

        if (id === 'indian_latest') {
          const indianLangs = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'pa'];
          const hindiChecks = await Promise.all(movies.map(async m => {
            if (indianLangs.includes(m.original_language)) {
              return await hasHindiAudio(m.id);
            }
            return false;
          }));
          movies = movies.filter((_, idx) => hindiChecks[idx]);
        } else if (id === 'hollywood_latest') {
          movies = movies.filter(m => m.original_language === 'en');
        }

        const formatted = await Promise.all(movies.map(m => formatMovie(m)));
        metas = formatted.filter(Boolean);
      } else if (type === 'series') {
        const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
          params: { api_key: TMDB_API_KEY, query: searchQuery, page: page },
          timeout: 12000
        });

        let series = response.data.results || [];
        if (id === 'hollywood_series_latest') {
          series = series.filter(s => s.original_language === 'en');
        }

        const formatted = await Promise.all(series.map(s => formatSeries(s)));
        metas = formatted.filter(Boolean);
      }
    } else {
      if (type === 'movie' && id === 'hollywood_latest') {
        const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
          params: {
            api_key: TMDB_API_KEY,
            'primary_release_date.lte': todayIST,
            with_original_language: 'en',
            region: 'US',
            with_release_type: '3',
            sort_by: 'primary_release_date.desc',
            'vote_count.gte': '5',
            page: page
          },
          timeout: 12000
        });

        const movies = response.data.results || [];
        const formatted = await Promise.all(movies.map(m => formatMovie(m)));
        metas = formatted.filter(Boolean);

      } else if (type === 'movie' && id === 'indian_latest') {
        const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
          params: {
            api_key: TMDB_API_KEY,
            'primary_release_date.lte': todayIST,
            with_original_language: 'hi',
            region: 'IN',
            with_release_type: '3',
            sort_by: 'primary_release_date.desc',
            'vote_count.gte': '0',
            page: page
          },
          timeout: 12000
        });

        let allMovies = response.data.results || [];

        const regionalLangs = ['ta', 'te', 'ml', 'kn', 'mr'];
        
        for (const lang of regionalLangs) {
          if (allMovies.length >= 25) break;

          const response2 = await axios.get('https://api.themoviedb.org/3/discover/movie', {
            params: {
              api_key: TMDB_API_KEY,
              'primary_release_date.lte': todayIST,
              with_original_language: lang,
              region: 'IN',
              with_release_type: '3',
              sort_by: 'primary_release_date.desc',
              'vote_count.gte': '0',
              page: page
            },
            timeout: 12000
          });

          const regionalMovies = response2.data.results || [];
          const hindiChecks = await Promise.all(regionalMovies.map(m => hasHindiAudio(m.id)));
          const filteredRegional = regionalMovies.filter((_, idx) => hindiChecks[idx]);
          allMovies = [...allMovies, ...filteredRegional];
        }

        const uniqueMovies = [];
        const seenIds = new Set();
        for (const movie of allMovies) {
          if (!seenIds.has(movie.id)) {
            seenIds.add(movie.id);
            uniqueMovies.push(movie);
          }
        }

        uniqueMovies.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
        const formatted = await Promise.all(uniqueMovies.slice(0, 20).map(m => formatMovie(m)));
        metas = formatted.filter(Boolean);

      } else if (type === 'series' && id === 'hollywood_series_latest') {
        const response = await axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: {
            api_key: TMDB_API_KEY,
            'first_air_date.lte': todayIST,
            with_original_language: 'en',
            sort_by: 'first_air_date.desc',
            'vote_count.gte': '10',
            page: page
          },
          timeout: 12000
        });

        const series = response.data.results || [];
        const formatted = await Promise.all(series.map(s => formatSeries(s)));
        metas = formatted.filter(Boolean);
      }
    }

    if (metas.length > 0) {
      cache.set(cacheKey, metas);
      if (skip === 0) {
        cache.set(pageSizeKey, metas.length, 86400);
        console.log(`Page size learned for ${pageSizeKeyBase}: ${metas.length}`);
      }
      console.log(`${id} p${page}: ${metas.length} items`);
    }

    return { metas, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
  } catch (error) {
    console.error(`Error ${id} p${page}:`, error.message);
    return { metas: [], cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('tt')) return { meta: null };
  const cleanId = id.replace('tt', '');
  const cacheKey = `meta_${type}_${cleanId}`;
  const cached = cache.get(cacheKey);
  if (cached) return { meta: cached };

  try {
    const findResponse = await axios.get(`https://api.themoviedb.org/3/find/tt${cleanId}`, {
      params: { api_key: TMDB_API_KEY, external_source: 'imdb_id' },
      timeout: 10000
    });

    const results = type === 'movie' ? findResponse.data.movie_results : findResponse.data.tv_results;
    if (!results || results.length === 0) return { meta: null };

    const tmdbId = results[0].id;
    const endpoint = type === 'series' ? 'tv' : 'movie';

    const response = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
      params: { api_key: TMDB_API_KEY, append_to_response: 'credits,videos,external_ids' },
      timeout: 10000
    });

    const item = response.data;
    const langLabel = getLanguageLabel(item.original_language || '');
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '';
    const cast = item.credits?.cast?.slice(0, 5).map(c => c.name) || [];
    const director = item.credits?.crew?.find(c => c.job === 'Director')?.name || '';
    const genres = item.genres?.map(g => g.name) || [];

    const meta = {
      id: `tt${cleanId}`,
      type: type,
      name: item.title || item.name || 'Unknown',
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
      posterShape: 'poster',
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : undefined,
      description: item.overview || 'No description',
      releaseInfo: ((item.release_date || item.first_air_date || '').substring(0, 4)) || undefined,
      imdbRating: rating,
      genres: genres,
      cast: cast,
      director: director,
      language: langLabel,
      runtime: (type === 'movie' && item.runtime) ? `${item.runtime} min` : undefined
    };

    cache.set(cacheKey, meta, 86400);
    return { meta };
  } catch (error) {
    console.error(`Meta error:`, error.message);
    return { meta: null };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log('Addon v3.0.1 - IST: ' + getISTDate());
