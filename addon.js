const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const PORT = process.env.PORT || 7000;

const cache = new NodeCache({ stdTTL: 7200, checkperiod: 600, maxKeys: 2000 });

const manifest = {
  id: 'org.indian.theatrical.catalogue',
  version: '2.0.0',
  name: '🎬 Indian + Hollywood Catalogue',
  description: 'Latest Indian movies, Hollywood movies, and TV series',
  logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    {
      id: 'hollywood_latest',
      name: '🎥 Hollywood Movies',
      type: 'movie',
      extra: [{ name: 'skip', isRequired: false }]
    },
    {
      id: 'indian_latest',
      name: '🇮🇳 Indian Movies',
      type: 'movie',
      extra: [{ name: 'skip', isRequired: false }]
    },
    {
      id: 'hollywood_series_latest',
      name: '📺 TV Series',
      type: 'series',
      extra: [{ name: 'skip', isRequired: false }]
    }
  ],
  behaviorHints: { configurable: false }
};

const builder = new addonBuilder(manifest);

function getCurrentDateIST() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  return istTime.toISOString().split('T')[0];
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
    cache.set(cacheKey, imdbId);
    return imdbId;
  } catch {
    cache.set(cacheKey, null);
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
      { params: { api_key: TMDB_API_KEY, language: 'en-US' }, timeout: 6000 }
    );
    const spokenLanguages = response.data.spoken_languages || [];
    const hasHindi = spokenLanguages.some(lang => lang.iso_639_1 === 'hi');
    cache.set(cacheKey, hasHindi);
    return hasHindi;
  } catch {
    cache.set(cacheKey, true);
    return true;
  }
}

async function formatMovie(movie) {
  if (!movie.poster_path) return null;

  const tmdbId = movie.id;
  if (!tmdbId) return null;

  const imdbId = await getIMDBId(tmdbId, 'movie');
  if (!imdbId) return null;

  const langLabel = getLanguageLabel(movie.original_language || '');
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '';

  return {
    id: imdbId,
    type: 'movie',
    name: movie.title || movie.original_title || 'Unknown',
    poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
    posterShape: 'poster',
    background: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : undefined,
    description: movie.overview || 'No description',
    releaseInfo: movie.release_date ? movie.release_date.substring(0, 4) : undefined,
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

  return {
    id: imdbId,
    type: 'series',
    name: series.name || series.original_name || 'Unknown',
    poster: `https://image.tmdb.org/t/p/w500${series.poster_path}`,
    posterShape: 'poster',
    background: series.backdrop_path ? `https://image.tmdb.org/t/p/original${series.backdrop_path}` : undefined,
    description: series.overview || 'No description',
    releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : undefined,
    imdbRating: rating,
    language: langLabel
  };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt(extra.skip || 0);
  const page = Math.floor(skip / 20) + 1;
  const cacheKey = `${id}_${page}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${id} page ${page}`);
    return { metas: cached };
  }

  console.log(`Fetching ${id} page ${page}`);

  try {
    let metas = [];
    const todayIST = getCurrentDateIST();

    if (type === 'movie' && id === 'hollywood_latest') {
      const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
        params: {
          api_key: TMDB_API_KEY,
          'primary_release_date.lte': todayIST,
          with_original_language: 'en',
          region: 'US',
          with_release_type: '2|3',
          sort_by: 'primary_release_date.desc',
          'vote_count.gte': '10',
          page: page
        },
        timeout: 12000
      });

      const movies = response.data.results || [];
      const formatted = await Promise.all(movies.map(m => formatMovie(m)));
      metas = formatted.filter(Boolean);
      console.log(`Hollywood: ${metas.length} movies`);

    } else if (type === 'movie' && id === 'indian_latest') {
      const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
        params: {
          api_key: TMDB_API_KEY,
          'primary_release_date.lte': todayIST,
          with_original_language: 'hi',
          region: 'IN',
          with_release_type: '2|3',
          sort_by: 'primary_release_date.desc',
          'vote_count.gte': '3',
          page: page
        },
        timeout: 12000
      });

      let allMovies = response.data.results || [];
      console.log(`Hindi movies: ${allMovies.length}`);

      if (allMovies.length < 20 && page <= 10) {
        const regionalLangs = ['ta', 'te', 'ml', 'kn', 'mr'];
        const regionalLang = regionalLangs[(page - 1) % regionalLangs.length];
        const regionalPage = Math.floor((page - 1) / regionalLangs.length) + 1;

        console.log(`Supplementing with ${regionalLang}...`);

        const response2 = await axios.get('https://api.themoviedb.org/3/discover/movie', {
          params: {
            api_key: TMDB_API_KEY,
            'primary_release_date.lte': todayIST,
            with_original_language: regionalLang,
            region: 'IN',
            with_release_type: '2|3',
            sort_by: 'primary_release_date.desc',
            'vote_count.gte': '3',
            page: regionalPage
          },
          timeout: 12000
        });

        const regionalMovies = response2.data.results || [];
        console.log(`${regionalLang} movies: ${regionalMovies.length}`);

        const hindiChecks = await Promise.all(regionalMovies.map(m => hasHindiAudio(m.id)));
        const filteredRegional = regionalMovies.filter((_, idx) => hindiChecks[idx]);
        console.log(`After Hindi filter: ${filteredRegional.length}`);

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
      console.log(`Indian: ${metas.length} movies`);

    } else if (type === 'series' && id === 'hollywood_series_latest') {
      const response = await axios.get('https://api.themoviedb.org/3/discover/tv', {
        params: {
          api_key: TMDB_API_KEY,
          'first_air_date.lte': todayIST,
          with_original_language: 'en',
          sort_by: 'first_air_date.desc',
          'vote_count.gte': '20',
          page: page
        },
        timeout: 12000
      });

      const series = response.data.results || [];
      const formatted = await Promise.all(series.map(s => formatSeries(s)));
      metas = formatted.filter(Boolean);
      console.log(`TV Series: ${metas.length} shows`);
    }

    if (metas.length > 0) {
      cache.set(cacheKey, metas);
      console.log(`Top 3: ${metas.slice(0, 3).map(m => m.name).join(', ')}`);
    }

    return { metas };
  } catch (error) {
    console.error(`Error ${id} page ${page}:`, error.message);
    return { metas: [] };
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
      params: {
        api_key: TMDB_API_KEY,
        append_to_response: 'credits,videos,external_ids'
      },
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

    cache.set(cacheKey, meta);
    return { meta };
  } catch (error) {
    console.error(`Meta error for ${id}:`, error.message);
    return { meta: null };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log('\n' + '='.repeat(60));
console.log('🎬 Indian + Hollywood Catalogue v2.0');
console.log('='.repeat(60));
console.log(`📅 Date (IST): ${getCurrentDateIST()}`);
console.log('='.repeat(60));
console.log('✨ Features:');
console.log('  • 🎥 Hollywood Movies');
console.log('  • 🇮🇳 Indian Movies');
console.log('  • 📺 TV Series');
console.log('  • ♾️ Infinite scroll');
console.log('='.repeat(60) + '\n');
