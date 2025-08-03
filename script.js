const BATCH_SIZE = 12;
let offset = 0;
let isLoading = false;
let hideGiveaways = true;
let currentRange = 'week';
let currentFeed = 'hot';
let multiplayerOnly = false;

const projectsContainer = document.getElementById('projects-container');
const loader = document.getElementById('loader');

const systemPrompt = `
You are an AI expert at evaluating web projects. Your task is to analyze a batch of projects and suggest a fair tip amount in credits for each one.
You will be given a JSON object containing an array of projects. For each project, you will receive its stats (views, likes, comments) and stats about its creator (total likes and views across all their projects).

Based on this data, you must provide a suggested tip amount and a short, one-sentence justification.
- Higher engagement (likes, views, comments) should lead to higher tips.
- A creator with a strong history (high total likes/views) might indicate higher quality work, justifying a better tip.
- A good ratio of likes to views is a positive signal.
- Balance these factors to determine a tip. Tip amounts should range from 10 to 500 credits.

Respond ONLY with a single JSON object. The JSON object should have a single key "suggestions" which is an array of objects. Each object in the array must follow this exact schema:
{
  "projectId": string, // The ID of the project
  "suggestedTip": number, // A number between 10 and 500
  "reasoning": string // A concise, one-sentence explanation for your suggestion.
}
Do not include any other text, comments, or explanations outside of the JSON structure.
`;

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

async function getCreatorStatsForBatch(projects) {
    const creatorIds = [...new Set(projects.map(p => p.project.created_by.id).filter(id => id))];
    if (creatorIds.length === 0) return {};

    const statsPromises = creatorIds.map(id =>
        fetch(`/api/v1/users/${id}/stats`).then(res => {
            if (!res.ok) {
                console.error(`Failed to fetch stats for user ${id}`);
                return null;
            }
            return res.json();
        }).catch(e => {
            console.error(`Failed to get stats for user ${id}:`, e);
            return null;
        })
    );

    const results = await Promise.all(statsPromises);
    const creatorStatsMap = {};
    creatorIds.forEach((id, index) => {
        if (results[index] && results[index].stats) {
            creatorStatsMap[id] = results[index].stats;
        } else {
            creatorStatsMap[id] = { total_likes: 0, total_views: 0 };
        }
    });
    return creatorStatsMap;
}

async function getAiSuggestions(projectsData) {
    try {
        const completion = await websim.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: JSON.stringify({ projects: projectsData }) }
            ],
            json: true,
        });

        const result = JSON.parse(completion.content);
        return result.suggestions.reduce((acc, suggestion) => {
            acc[suggestion.projectId] = suggestion;
            return acc;
        }, {});
    } catch (error) {
        console.error("Error getting AI suggestions:", error);
        return {};
    }
}

function isGiveawayOrTipAskingSite(project) {
    const title = (project.title || '').toLowerCase();
    const description = (project.description || '').toLowerCase();
    
    const giveawayKeywords = [
        'giveaway', 'free credits', 'free tips', 'win credits', 'earn credits',
        'credit generator', 'free money', 'get rich', 'make money fast',
        'tip me', 'send tips', 'donate credits', 'support me with credits',
        'please tip', 'need credits', 'credit request', 'asking for tips',
        'help me with credits', 'fund my', 'crowdfund', 'donation'
    ];
    
    const text = title + ' ' + description;
    return giveawayKeywords.some(keyword => text.includes(keyword));
}

function renderProjects(projects, suggestions) {
    console.log('Rendering', projects.length, 'projects');
    
    projects.forEach((item) => {
        const { project } = item;
        
        // Skip giveaway/tip-asking sites if toggle is enabled
        if (hideGiveaways && isGiveawayOrTipAskingSite(project)) {
            console.log('Skipping giveaway/tip-asking site:', project.title);
            return;
        }
        
        const creator = project.created_by;
        const views = item.views || 0;
        const likes = item.likes || 0;
        const comments = item.comments || 0;
        const suggestion = suggestions[project.id] || { 
            suggestedTip: 25, 
            reasoning: 'Default suggestion - AI analysis unavailable.' 
        };
        
        console.log('Rendering project:', project.title, 'with suggestion:', suggestion);
        
        const card = document.createElement('div');
        card.className = 'project-card';
        
        // Use project revision's site_id or fall back to a placeholder
        const thumbnailUrl = project.thumbnail?.url || 
                           (item.site?.id ? `https://images.websim.com/v1/site/${item.site.id}/600` : '') ||
                           (item.project_revision?.site_id ? `https://images.websim.com/v1/site/${item.project_revision.site_id}/600` : '');
        
        const projectUrl = `https://websim.com/p/${project.id}`;
        const creatorUrl = creator ? `https://websim.com/@${creator.username}`: '';

        card.innerHTML = `
            ${thumbnailUrl ? `<a href="${projectUrl}" target="_blank">
                <img src="${thumbnailUrl}" alt="${project.title || 'Project thumbnail'}" class="project-thumbnail" onerror="this.style.display='none'">
            </a>` : ''}
            <div class="card-content">
                <a href="${projectUrl}" target="_blank" class="project-title">${project.title || 'Untitled Project'}</a>
                ${creator ? `
                <div class="creator-info">
                    <a href="${creatorUrl}" target="_blank"><img src="https://images.websim.com/avatar/${creator.username}" alt="${creator.username}" class="creator-avatar"></a>
                    <a href="${creatorUrl}" target="_blank" class="creator-link">@${creator.username}</a>
                </div>` : ''}
                <div class="stats">
                    <div class="stat"><span class="stat-value">${formatNumber(views)}</span> Views</div>
                    <div class="stat"><span class="stat-value">${formatNumber(likes)}</span> Hearts</div>
                    <div class="stat"><span class="stat-value">${formatNumber(comments)}</span> Comments</div>
                </div>
                <div class="ai-suggestion">
                    <h3>💡 AI Tip Suggestion</h3>
                    <p>
                        <span class="tip-amount">${suggestion.suggestedTip} credits</span> - ${suggestion.reasoning}
                    </p>
                </div>
            </div>
        `;
        projectsContainer.appendChild(card);
    });
    
    console.log('Finished rendering projects. Total cards:', projectsContainer.children.length);
}

async function fetchAndDisplayProjects() {
    if (isLoading) return;
    isLoading = true;
    loader.style.display = 'block';

    try {
        const url = new URL(`${window.location.origin}/api/v1/feed/trending`);
        url.searchParams.set('limit', BATCH_SIZE);
        url.searchParams.set('offset', offset);
        url.searchParams.set('range', currentRange);
        url.searchParams.set('feed', currentFeed);
        if (multiplayerOnly) {
            url.searchParams.set('is_multiplayer', 'true');
        }
        
        console.log('Fetching from:', url.toString());
        
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch trending feed: ${res.statusText}`);
        }
        const response = await res.json();
        
        console.log('Raw response:', response);
        console.log('Projects in response:', response.feed?.data?.length);
        
        // Less restrictive filtering - only require project and created_by
        let projects = response.feed?.data?.filter(item => 
            item.project && 
            item.project.created_by && 
            item.project.id
        ) || [];
        
        // Additional filtering for giveaways if toggle is enabled
        if (hideGiveaways) {
            projects = projects.filter(item => !isGiveawayOrTipAskingSite(item.project));
        }
        
        console.log('Filtered projects:', projects.length);
        
        if (projects.length === 0) {
            const message = offset === 0 ? 
                'Could not find any projects. Please try again later.' : 
                'No more projects to display.';
            loader.innerHTML = `<p>${message}</p>`;
            loader.style.display = 'block';
            return;
        }

        console.log('Getting creator stats for', projects.length, 'projects');
        const creatorStats = await getCreatorStatsForBatch(projects);
        console.log('Creator stats:', creatorStats);

        const projectsDataForAI = projects.map(item => ({
            projectId: item.project.id,
            projectStats: {
                views: item.views || 0,
                likes: item.likes || 0,
                comments: item.comments || 0
            },
            creatorStats: creatorStats[item.project.created_by.id] || { total_likes: 0, total_views: 0 }
        }));
        
        console.log('Data for AI:', projectsDataForAI);
        
        const suggestions = await getAiSuggestions(projectsDataForAI);
        console.log('AI suggestions:', suggestions);
        
        renderProjects(projects, suggestions);
        
        offset += projects.length;
        loader.style.display = 'none';

    } catch (error) {
        console.error("Failed to fetch and display projects:", error);
        loader.innerHTML = '<p>Could not load projects. Please try again later.</p>';
        loader.style.display = 'block';
    } finally {
        isLoading = false;
    }
}

function handleInfiniteScroll() {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500 && !isLoading) {
        fetchAndDisplayProjects();
    }
}

function resetAndReload() {
    projectsContainer.innerHTML = '';
    offset = 0;
    fetchAndDisplayProjects();
}

// Toggle and filter event listeners
document.addEventListener('DOMContentLoaded', () => {
    const hideGiveawaysToggle = document.getElementById('hide-giveaways');
    const rangeFilter = document.getElementById('range-filter');
    const feedFilter = document.getElementById('feed-filter');
    const multiplayerToggle = document.getElementById('multiplayer-only');
    
    hideGiveawaysToggle.addEventListener('change', (e) => {
        hideGiveaways = e.target.checked;
        resetAndReload();
    });
    
    rangeFilter.addEventListener('change', (e) => {
        currentRange = e.target.value;
        resetAndReload();
    });
    
    feedFilter.addEventListener('change', (e) => {
        currentFeed = e.target.value;
        resetAndReload();
    });
    
    multiplayerToggle.addEventListener('change', (e) => {
        multiplayerOnly = e.target.checked;
        resetAndReload();
    });
});

window.addEventListener('scroll', handleInfiniteScroll);
window.addEventListener('resize', handleInfiniteScroll);

// Initial load
fetchAndDisplayProjects();