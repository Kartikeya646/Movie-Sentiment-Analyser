/*
* AI Movie Review Classifier - BACKEND
* This server.js file does two things:
* 1.  (/get-movie-data): Fetches movie data (plot, poster, ratings) from TMDB and OMDb.
* It fetches UP TO 50 PAGES (~1000 reviews) from TMDB in safe batches.
* NEW: It now includes the 'imdbId' in the final response.
* 2.  (/autocomplete): Provides search suggestions for the frontend.
*/

const express = require('express');
const fetch = require('node-fetch'); // Make sure you have 'node-fetch' installed (npm install node-fetch@2)
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors()); // Allow requests from our frontend

// --- !!! ADD YOUR API KEYS HERE !!! ---
// 1. Get your TMDB API Key (v3 auth) from: https://www.themoviedb.org/settings/api
// 2. Get your OMDb API Key from: https://www.omdbapi.com/apikey.aspx
const TMDB_API_KEY = "f1498f03b8d3474d84055d2fa5a2d431";
const OMDB_API_KEY = "3a4c13b1";
// --- --- --- --- --- --- --- --- --- ---

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Endpoint: /autocomplete
 * Provides real-time search suggestions as the user types.
 */
app.get('/autocomplete', async (req, res) => {
    const query = req.query.query;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    const url = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&language=en-US&query=${encodeURIComponent(query)}&page=1&include_adult=false`;

    try {
        const tmdbRes = await fetch(url);
        const tmdbData = await tmdbRes.json();

        // Map results to a simpler format for the frontend
        const suggestions = tmdbData.results.slice(0, 5).map(movie => ({
            title: movie.title,
            year: movie.release_date ? movie.release_date.split('-')[0] : 'N/A',
            fullText: `${movie.title} (${movie.release_date ? movie.release_date.split('-')[0] : 'N/A'})`
        }));
        
        res.json(suggestions);

    } catch (error) {
        console.error('Autocomplete Error:', error);
        res.status(500).json({ error: 'Failed to fetch autocomplete suggestions' });
    }
});


/**
 * Endpoint: /get-movie-data
 * Fetches all movie details: plot, poster, ratings, and now up to 1000 reviews.
 */
app.get('/get-movie-data', async (req, res) => {
    let title = req.query.title;
    if (!title) {
        return res.status(400).json({ error: 'Title parameter is required' });
    }

    let searchYear = '';

    // Check if the query has a year (e.g., "Oppenheimer (2023)")
    const yearMatch = title.match(/\((\d{4})\)$/);
    if (yearMatch) {
        searchYear = yearMatch[1];
        title = title.replace(/\s*\(\d{4}\)$/, '').trim(); // Remove year from title
    }

    let movieImdbId = null; // Variable to store the IMDb ID

    try {
        // --- Step 1: Search TMDB for the movie to get its ID ---
        let searchUrl = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&include_adult=false`;
        if (searchYear) {
            searchUrl += `&primary_release_year=${searchYear}`;
        }

        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        
        if (!searchData.results || searchData.results.length === 0) {
            return res.status(404).json({ error: `Movie '${title}' not found on TMDB.` });
        }

        const movie = searchData.results[0];
        const tmdbId = movie.id;

        // --- Step 2: Get full movie details from TMDB (for plot/poster AND imdb_id) ---
        const detailsUrl = `${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const detailsRes = await fetch(detailsUrl);
        const detailsData = await detailsRes.json();

        // Store the IMDb ID
        movieImdbId = detailsData.imdb_id;

        // --- Step 3: Get reviews from TMDB (BATCHING LOGIC) ---
        console.log(`Starting review fetch for movie ID: ${tmdbId}`);
        let allReviews = [];
        const reviewsUrlPage1 = `${TMDB_BASE_URL}/movie/${tmdbId}/reviews?api_key=${TMDB_API_KEY}&language=en-US&page=1`;
        
        const reviewsResPage1 = await fetch(reviewsUrlPage1);
        const reviewsDataPage1 = await reviewsResPage1.json();
        
        if (reviewsDataPage1.results) {
            allReviews = allReviews.concat(reviewsDataPage1.results.map(r => r.content));
        }

        // Check total pages and fetch more (up to 50 pages total = 1000 reviews)
        const totalPages = reviewsDataPage1.total_pages;
        console.log(`Total review pages found: ${totalPages}`);

        if (totalPages > 1) {
            const pagesToFetch = Math.min(totalPages, 50); // Max 50 pages
            console.log(`Fetching up to ${pagesToFetch} pages...`);

            const BATCH_SIZE = 25; 
            
            for (let page = 2; page <= pagesToFetch; page += BATCH_SIZE) {
                let reviewPromises = [];
                const endPage = Math.min(page + BATCH_SIZE - 1, pagesToFetch);
                
                console.log(`Fetching batch: pages ${page} to ${endPage}`);

                for (let currentPage = page; currentPage <= endPage; currentPage++) {
                    const reviewUrl = `${TMDB_BASE_URL}/movie/${tmdbId}/reviews?api_key=${TMDB_API_KEY}&language=en-US&page=${currentPage}`;
                    reviewPromises.push(
                        fetch(reviewUrl)
                            .then(res => res.json())
                            .catch(err => {
                                console.error(`Failed to fetch page ${currentPage}:`, err.message);
                                return { results: [] }; // Return empty on error
                            })
                    );
                }

                const additionalReviewPages = await Promise.all(reviewPromises);

                additionalReviewPages.forEach(pageData => {
                    if (pageData.results) {
                        allReviews = allReviews.concat(pageData.results.map(r => r.content));
                    }
                });

                if (endPage < pagesToFetch) {
                    console.log('Batch complete. Waiting 10 seconds before next batch...');
                    await sleep(10000); // 10-second delay
                }
            }
        }
        
        console.log(`Total reviews fetched: ${allReviews.length}`);

        // --- Step 4: Get ratings from OMDb (using IMDb ID) ---
        let omdbRatings = [];
        if (movieImdbId) { // Use the stored IMDb ID
            const omdbUrl = `https://www.omdbapi.com/?i=${movieImdbId}&apikey=${OMDB_API_KEY}`;
            const omdbRes = await fetch(omdbUrl);
            const omdbData = await omdbRes.json();
            
            if (omdbData.Ratings) {
                omdbRatings = omdbData.Ratings;
            }
        }

        // --- Step 5: Consolidate and send the final response ---
        const responsePayload = {
            title: detailsData.title,
            year: detailsData.release_date ? detailsData.release_date.split('-')[0] : 'N/A',
            plot: detailsData.overview,
            poster: detailsData.poster_path ? `https://image.tmdb.org/t/p/w500${detailsData.poster_path}` : 'https://placehold.co/500x750/374151/4b5563?text=No+Poster',
            ratings: omdbRatings,
            reviews: allReviews,
            imdbId: movieImdbId // *** NEW: Send this to the frontend ***
        };

        res.json(responsePayload);

    } catch (error) {
        console.error('Main /get-movie-data Error:', error);
        res.status(500).json({ error: 'Server failed to fetch movie data' });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
    console.log('Available Endpoints:');
    console.log(`  GET http://localhost:${PORT}/autocomplete?query=...`);
    console.log(`  GET http://localhost:${PORT}/get-movie-data?title=...`);
});

